"""The target under test: a PRETRAINED humanoid policy downloaded from the Hugging Face hub.

Nothing here trains anything. The policy is somebody else's published checkpoint and Tail
Bazaar treats it exactly the way it treats the cart's `controller.py`: as a fixed artefact
pinned by hash, never edited, whose operating range is the product question.

Provenance (all four identifiers are checked at load time, not just recorded)
---------------------------------------------------------------------------
  repo      farama-minari/Humanoid-v5-SAC-expert   (Hugging Face model hub)
  revision  f9130b25c70584670ceac33eb1d06fbc418d691a  — pinned commit, not `main`
  file      humanoid-v5-sac-expert.zip, sha256 5a7b38be...  (a Stable-Baselines3 SAC save)
  weights   policy.pth inside that zip, sha256 6437d3dd...

The publisher is the Farama Foundation's Minari project (offline-RL datasets); the model
card reports mean_reward 8127.00 +/- 46.46 over 10 deterministic episodes of Gymnasium
`Humanoid-v5`, trained with Stable-Baselines3 2.4.0a10 for 1e8 steps.

LICENCE — READ THIS BEFORE REDISTRIBUTING. The model repository declares NO SPDX licence:
there is no `license:` tag in its card metadata and no LICENSE file in the repo. See
LICENCE_NOTE below for exactly what is and is not known. Nothing from that repository is
vendored into this git repository; the weights are downloaded at run time into
`sim/.cache/` (git-ignored) and only their hashes are published in evidence.

How the policy is evaluated here
--------------------------------
Stable-Baselines3 stores the actor as a plain torch `state_dict`. Rather than depend on
torch and stable-baselines3 at run time (~2 GB of wheels for a 170k-parameter MLP), this
module reads the `.pth` container directly with a restricted unpickler and evaluates the
actor in numpy. The arithmetic is exactly SB3's `SACPolicy.predict(deterministic=True)`:

    h  = relu(W0 @ obs + b0)            actor.latent_pi.0    (348 -> 256)
    h  = relu(W2 @ h   + b2)            actor.latent_pi.2    (256 -> 256)
    u  = tanh(Wmu @ h  + bmu)           actor.mu             (256 -> 17), squashed
    a  = low + 0.5 * (u + 1) * (high - low)   SB3 `unscale_action`, squash_output=True

`actor.log_std` is loaded but unused: deterministic evaluation takes the mean action. The
reimplementation is validated empirically — it reproduces the model card's published
return to within the card's own quoted standard deviation (see evidence/humanoid).

The restricted unpickler refuses every global except the three needed to rebuild a
`state_dict` (`torch._utils._rebuild_tensor_v2`, `torch.*Storage`, `collections.OrderedDict`),
so loading a downloaded `.pth` cannot execute arbitrary code the way `torch.load` can.
"""

from __future__ import annotations

import hashlib
import io
import os
import pickle
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np

POLICY_ID = "farama-minari-humanoid-v5-sac-expert"
POLICY_ALGO = "SAC"
POLICY_FRAMEWORK = "stable-baselines3"
POLICY_FRAMEWORK_VERSION = "2.4.0a10"  # from _stable_baselines3_version inside the zip

REPO_ID = "farama-minari/Humanoid-v5-SAC-expert"
REPO_REVISION = "f9130b25c70584670ceac33eb1d06fbc418d691a"
ARCHIVE_FILENAME = "humanoid-v5-sac-expert.zip"
ARCHIVE_SHA256 = "5a7b38be61afb41cfe37acdc70e9997f29415a833684d91773c6049951a18cd6"
ARCHIVE_BYTES = 7179847
WEIGHTS_MEMBER = "policy.pth"
WEIGHTS_SHA256 = "6437d3dd02bc2fc92f5f2bcbf5d48eac0e5db209d4aae3bb7d039f14df3e18ef"
WEIGHTS_BYTES = 3222902

# Reported by the publisher on the model card, NOT measured here. The numbers this project
# measured itself are in the nominal suite and in evidence/humanoid/README.md.
PUBLISHED_MEAN_REWARD = 8127.004316699999
PUBLISHED_STD_REWARD = 46.459923147992505
PUBLISHED_EVAL_EPISODES = 10

LICENCE_NOTE = {
    "declared_spdx": None,
    "status": "NOT DECLARED by the model repository",
    "checked": [
        "cardData.license is absent from the Hugging Face model metadata",
        "no license:* tag on the model repository",
        "no LICENSE file among the repository's files",
    ],
    "publisher": "Farama Foundation — Minari project (https://huggingface.co/farama-minari)",
    "publisher_note": (
        "The Farama Foundation maintains Gymnasium and Minari and publishes these checkpoints as "
        "the behaviour policies behind its offline-RL datasets. Its source projects are MIT "
        "licensed, but that licence is NOT restated on this model repository, so no licence is "
        "asserted here on its behalf."
    ),
    "what_this_project_does": (
        "the weights are downloaded at run time and are NOT vendored, redistributed or modified; "
        "only their sha256 digests and the measured behaviour are published as evidence"
    ),
    "alternatives_considered": [
        "sb3/sac-Humanoid-v3 (RL Baselines3 Zoo, mean_reward 6251.93) — also declares no licence",
        "cleanrl/sdpkjc Humanoid-v4 checkpoints — also declare no licence",
        "hwihwalab/neuromotion-humanoid-v5-ppo — MIT licensed, but its own card reports a mean "
        "survival of 88.5 control steps (~1.3 s), i.e. it does not balance, so it cannot serve as "
        "a balance target",
    ],
}

PROVENANCE_URL = f"https://huggingface.co/{REPO_ID}/tree/{REPO_REVISION}"

# Layer names inside the SB3 SAC state_dict that this module actually uses.
ACTOR_KEYS = (
    "actor.latent_pi.0.weight",
    "actor.latent_pi.0.bias",
    "actor.latent_pi.2.weight",
    "actor.latent_pi.2.bias",
    "actor.mu.weight",
    "actor.mu.bias",
)

_CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "hf"

_TORCH_STORAGE_DTYPES = {
    "FloatStorage": np.dtype("<f4"),
    "DoubleStorage": np.dtype("<f8"),
    "HalfStorage": np.dtype("<f2"),
    "LongStorage": np.dtype("<i8"),
    "IntStorage": np.dtype("<i4"),
    "ShortStorage": np.dtype("<i2"),
    "CharStorage": np.dtype("<i1"),
    "ByteStorage": np.dtype("<u1"),
    "BoolStorage": np.dtype("?"),
}


class _StorageStub:
    """Stand-in for a `torch.*Storage` class; carries only the element dtype."""

    def __init__(self, dtype: np.dtype) -> None:
        self.dtype = dtype


def read_torch_state_dict(raw: bytes) -> dict[str, np.ndarray]:
    """Decode a `torch.save`d state_dict into numpy arrays, without importing torch.

    The `.pth` container is a zip holding `archive/data.pkl` (a pickle whose tensors are
    persistent ids) plus one raw little-endian buffer per storage under `archive/data/`.
    Only the globals needed to rebuild tensors are permitted; anything else raises.
    """
    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = zf.namelist()
    if not names:
        raise ValueError("empty .pth container")
    prefix = names[0].split("/")[0]
    byteorder_member = f"{prefix}/byteorder"
    if byteorder_member in names:
        order = zf.read(byteorder_member).decode().strip()
        if order != "little":
            raise ValueError(f"unsupported storage byte order {order!r}")

    def rebuild_tensor(storage: tuple[np.dtype, str, int], offset: int, size, stride, *_rest) -> np.ndarray:
        dtype, key, numel = storage
        flat = np.frombuffer(zf.read(f"{prefix}/data/{key}"), dtype=dtype)
        if flat.size != numel:
            raise ValueError(f"storage {key} has {flat.size} elements, expected {numel}")
        view = np.lib.stride_tricks.as_strided(
            flat[offset:],
            shape=tuple(int(s) for s in size),
            strides=tuple(int(s) * dtype.itemsize for s in stride),
        )
        return np.ascontiguousarray(view)

    class _Restricted(pickle.Unpickler):
        def find_class(self, module: str, name: str) -> Any:
            if module == "torch" and name in _TORCH_STORAGE_DTYPES:
                return _StorageStub(_TORCH_STORAGE_DTYPES[name])
            if module == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild_tensor
            if module == "collections" and name == "OrderedDict":
                return OrderedDict
            raise pickle.UnpicklingError(f"refused to load global {module}.{name}")

        def persistent_load(self, pid: Any) -> Any:
            tag, storage_type, key, _location, numel = pid
            if tag != "storage":
                raise pickle.UnpicklingError(f"unsupported persistent id {tag!r}")
            return (storage_type.dtype, key, int(numel))

    return dict(_Restricted(io.BytesIO(zf.read(f"{prefix}/data.pkl"))).load())


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def download_archive(allow_download: bool = True) -> Path:
    """Return the local path to the pinned SB3 archive, downloading it if needed.

    Set TAILBAZAAR_HUMANOID_ARCHIVE to use a pre-fetched copy on an offline machine; the
    sha256 check below applies either way, so an offline copy cannot be a different file.
    """
    override = os.environ.get("TAILBAZAAR_HUMANOID_ARCHIVE")
    if override:
        return Path(override)
    from huggingface_hub import hf_hub_download  # imported lazily: only needed on a cache miss

    return Path(
        hf_hub_download(
            repo_id=REPO_ID,
            filename=ARCHIVE_FILENAME,
            revision=REPO_REVISION,
            cache_dir=str(_CACHE_DIR),
            local_files_only=not allow_download,
        )
    )


class HumanoidPolicy:
    """The pinned SAC actor, evaluated deterministically in numpy."""

    def __init__(self, weights: dict[str, np.ndarray], digests: dict[str, str]) -> None:
        self.W0 = np.ascontiguousarray(weights["actor.latent_pi.0.weight"], dtype=np.float32)
        self.b0 = np.ascontiguousarray(weights["actor.latent_pi.0.bias"], dtype=np.float32)
        self.W2 = np.ascontiguousarray(weights["actor.latent_pi.2.weight"], dtype=np.float32)
        self.b2 = np.ascontiguousarray(weights["actor.latent_pi.2.bias"], dtype=np.float32)
        self.Wmu = np.ascontiguousarray(weights["actor.mu.weight"], dtype=np.float32)
        self.bmu = np.ascontiguousarray(weights["actor.mu.bias"], dtype=np.float32)
        self.digests = digests
        self.obs_dim = int(self.W0.shape[1])
        self.act_dim = int(self.Wmu.shape[0])
        self.n_parameters = int(sum(w.size for w in (self.W0, self.b0, self.W2, self.b2, self.Wmu, self.bmu)))

    def action(self, obs: np.ndarray, low: np.ndarray, high: np.ndarray) -> np.ndarray:
        """SB3 `predict(deterministic=True)` for a squashed-output Box action space."""
        x = np.asarray(obs, dtype=np.float32)
        x = np.maximum(self.W0 @ x + self.b0, 0.0, dtype=np.float32)
        x = np.maximum(self.W2 @ x + self.b2, 0.0, dtype=np.float32)
        squashed = np.tanh(self.Wmu @ x + self.bmu)
        return low + 0.5 * (squashed + 1.0) * (high - low)

    def identity(self) -> dict[str, Any]:
        """The pinned target identity that goes into every run document."""
        return {
            "policy_id": POLICY_ID,
            "algo": POLICY_ALGO,
            "framework": POLICY_FRAMEWORK,
            "framework_version": POLICY_FRAMEWORK_VERSION,
            "repo_id": REPO_ID,
            "repo_revision": REPO_REVISION,
            "repo_url": PROVENANCE_URL,
            "archive_filename": ARCHIVE_FILENAME,
            "archive_sha256": "sha256:" + self.digests["archive"],
            "archive_bytes": ARCHIVE_BYTES,
            "weights_member": WEIGHTS_MEMBER,
            "weights_sha256": "sha256:" + self.digests["weights"],
            "weights_bytes": WEIGHTS_BYTES,
            "actor_tensor_sha256": "sha256:" + self.digests["actor_tensors"],
            "actor_layers": list(ACTOR_KEYS),
            "obs_dim": self.obs_dim,
            "action_dim": self.act_dim,
            "hidden_sizes": [int(self.b0.size), int(self.b2.size)],
            "activation": "relu",
            "evaluation": "deterministic mean action, tanh-squashed then unscaled to the action box",
            "evaluated_by": "numpy reimplementation of stable_baselines3.SACPolicy.predict; torch is not a run-time dependency",
            "n_actor_parameters": self.n_parameters,
            "published_mean_reward": PUBLISHED_MEAN_REWARD,
            "published_std_reward": PUBLISHED_STD_REWARD,
            "published_eval_episodes": PUBLISHED_EVAL_EPISODES,
            "published_reward_is_the_publishers_claim_not_a_measurement_here": True,
            "licence": LICENCE_NOTE,
        }


_LOADED: HumanoidPolicy | None = None


def load_policy(allow_download: bool = True) -> HumanoidPolicy:
    """Download (once), verify every pinned hash, and return the actor. Cached per process."""
    global _LOADED
    if _LOADED is not None:
        return _LOADED
    path = download_archive(allow_download=allow_download)
    archive = path.read_bytes()
    archive_digest = _sha256(archive)
    if archive_digest != ARCHIVE_SHA256:
        raise ValueError(
            f"{ARCHIVE_FILENAME} sha256 {archive_digest} != pinned {ARCHIVE_SHA256}; refusing to run"
        )
    raw = zipfile.ZipFile(io.BytesIO(archive)).read(WEIGHTS_MEMBER)
    weights_digest = _sha256(raw)
    if weights_digest != WEIGHTS_SHA256:
        raise ValueError(f"{WEIGHTS_MEMBER} sha256 {weights_digest} != pinned {WEIGHTS_SHA256}")
    state = read_torch_state_dict(raw)
    missing = [k for k in ACTOR_KEYS if k not in state]
    if missing:
        raise ValueError(f"actor tensors missing from the checkpoint: {missing}")
    # A digest over exactly the tensors used for control, so the evidence pins the bytes that
    # actually produced the trajectory rather than the whole file the critics also live in.
    h = hashlib.sha256()
    for k in ACTOR_KEYS:
        arr = np.ascontiguousarray(state[k], dtype=np.float32)
        h.update(k.encode())
        h.update(str(arr.shape).encode())
        h.update(arr.tobytes())
    _LOADED = HumanoidPolicy(state, {"archive": archive_digest, "weights": weights_digest, "actor_tensors": h.hexdigest()})
    return _LOADED
