"""The target under test: a PRETRAINED pick-and-place policy downloaded from the Hugging Face hub.

Nothing here trains anything. The policy is somebody else's published checkpoint and Tail
Bazaar treats it exactly the way it treats the cart's `controller.py` and the humanoid's SAC
actor: as a fixed artefact pinned by hash, never edited, whose operating range is the
product question.

Provenance (all four identifiers are CHECKED at load time, not merely recorded)
------------------------------------------------------------------------------
  repo      IntelliGrow/FetchPickAndPlace-v4          (Hugging Face model hub)
  revision  04bb1bf735f6a2957d8b77d185afe46ba112357a  — pinned commit, not `main`
  file      sac-FetchPickAndPlace-v4.zip, sha256 2b1b30dd...  (a Stable-Baselines3 SAC save)
  weights   policy.pth inside that zip, sha256 79250646...

Soft Actor-Critic with Hindsight Experience Replay, Stable-Baselines3 2.7.0, MultiInputPolicy
over the environment's Dict observation. The model card reports mean_reward -9.70 +/- 4.17
over 10 deterministic episodes of Gymnasium-Robotics `FetchPickAndPlace-v4`. The reward is
sparse (-1 per control step at which the block is not within 5 cm of the goal, 50 steps per
episode), so -9.70 means the block reaches the goal after about ten steps and stays there,
and a single failed episode would have scored -50 and blown the quoted spread wide open.

WHY THIS CHECKPOINT. The brief preferred an rl-zoo3/sb3 checkpoint. `sb3/tqc-FetchPickAndPlace-v1`
was loaded and measured too (see ALTERNATIVES_CONSIDERED and evidence/arm/README.md): it also
places 20/20, but it was trained on `FetchPickAndPlace-v1`, a mujoco-py environment that no
longer exists, and behind `sb3_contrib`'s TimeFeatureWrapper. Running it means transplanting a
policy across an environment-version boundary AND reimplementing a wrapper, and its publisher's
number was measured on the version that is gone, so it cannot be reproduced as a check on the
harness. This checkpoint was trained and published on the exact environment version that runs
here, which makes the publisher's own number a usable gate on the numpy reimplementation below.

LICENCE — READ THIS BEFORE REDISTRIBUTING. The model repository declares NO SPDX licence.
So does every other FetchPickAndPlace checkpoint found on the hub; see LICENCE_NOTE for the
full survey. Nothing from that repository is vendored into this git repository: the weights
are downloaded at run time into `sim/.cache/` (git-ignored) and only their sha256 digests and
the measured behaviour are published as evidence.

How the policy is evaluated (and why there is no torch dependency)
-----------------------------------------------------------------
Stable-Baselines3 stores the actor as a plain torch `state_dict`. Rather than depend on torch
and stable-baselines3 at run time (~2 GB of wheels for a 75k-parameter MLP), this module reads
the `.pth` container directly with the RESTRICTED unpickler already written for the humanoid
target and evaluates the actor in numpy. The arithmetic is exactly SB3's
`SACPolicy.predict(deterministic=True)` for a `MultiInputPolicy` whose feature extractor is the
parameter-free `CombinedExtractor`:

    x  = concat(obs[k] for k in sorted(obs))       CombinedExtractor: flatten + concat, no weights
    h  = relu(W0 @ x + b0)                         actor.latent_pi.0   (31 -> 256)
    h  = relu(W2 @ h + b2)                         actor.latent_pi.2   (256 -> 256)
    u  = tanh(Wmu @ h + bmu)                       actor.mu            (256 -> 4), squashed
    a  = low + 0.5 * (u + 1) * (high - low)        SB3 `unscale_action`, squash_output=True

The key order matters and is not a guess: `CombinedExtractor` iterates
`observation_space.spaces.items()`, and Gymnasium's `Dict` space stores its subspaces sorted by
key, so the concatenation is achieved_goal (3), desired_goal (3), observation (25) = 31. The
first layer's weight has exactly 31 input columns, which is the check that the order is right —
any other order would still have 31 columns but would not place the block, and it does place it
20/20. `actor.log_std` is loaded but unused: deterministic evaluation takes the mean action.
"""

from __future__ import annotations

import hashlib
import io
import os
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

# The restricted unpickler is imported, not copied: see tailbazaar_sim/arm/__init__.py. It
# refuses every pickle global except the three needed to rebuild a state_dict, so loading a
# downloaded `.pth` cannot execute arbitrary code the way `torch.load` can. Nothing in the
# humanoid package is modified by importing it.
from ..humanoid.policy import read_torch_state_dict

POLICY_ID = "intelligrow-fetch-pick-and-place-v4-sac-her"
POLICY_ALGO = "SAC"
POLICY_ALGO_DETAIL = "SAC + Hindsight Experience Replay (HerReplayBuffer), MultiInputPolicy"
POLICY_FRAMEWORK = "stable-baselines3"
POLICY_FRAMEWORK_VERSION = "2.7.0"  # from _stable_baselines3_version inside the zip

REPO_ID = "IntelliGrow/FetchPickAndPlace-v4"
REPO_REVISION = "04bb1bf735f6a2957d8b77d185afe46ba112357a"
ARCHIVE_FILENAME = "sac-FetchPickAndPlace-v4.zip"
ARCHIVE_SHA256 = "2b1b30dd5e778a1f04868891eaa447ad7387f79d1f4db3514e01b9b189be1481"
ARCHIVE_BYTES = 3374885
WEIGHTS_MEMBER = "policy.pth"
WEIGHTS_SHA256 = "792506461c719beb3926cb4230b258bdcf47ed8efbbc3eca8b31539e4fd710ea"
WEIGHTS_BYTES = 1520771

# Reported by the publisher in results.json on the model repository, NOT measured here. The
# numbers this project measured itself are in the nominal suite and evidence/arm/README.md.
PUBLISHED_MEAN_REWARD = -9.7
PUBLISHED_STD_REWARD = 4.172529209005013
PUBLISHED_EVAL_EPISODES = 10
PUBLISHED_DETERMINISTIC = True
PUBLISHED_ENV_ID = "FetchPickAndPlace-v4"

# The Dict observation keys, in the order SB3's CombinedExtractor concatenates them. Derived
# from Gymnasium's sorted Dict space, and checked against the first layer's input width.
OBS_KEY_ORDER = ("achieved_goal", "desired_goal", "observation")
OBS_KEY_DIMS = (3, 3, 25)

ALTERNATIVES_CONSIDERED = [
    {
        "repo_id": "sb3/tqc-FetchPickAndPlace-v1",
        "algo": "TQC + HER, rl-zoo3, net_arch [512,512,512]",
        "licence": "none declared",
        "measured_here": "places 20/20 on FetchPickAndPlace-v4 over seeds 0-19",
        "why_not_primary": (
            "trained on FetchPickAndPlace-v1 (the mujoco-py environment, no longer installable) and "
            "behind sb3_contrib's TimeFeatureWrapper, so running it needs both an environment-version "
            "transplant and a wrapper reimplementation, and its published mean_reward was measured on "
            "an environment that cannot be run here — it cannot serve as a check on this harness"
        ),
    },
    {
        "repo_id": "hhmm1122/fetch-pickandplace-sac-her",
        "algo": "SAC + HER, net_arch [512,512,512]",
        "licence": "none declared",
        "measured_here": "places 20/20 on FetchPickAndPlace-v4 over seeds 0-19",
        "why_not_primary": (
            "trained on the right environment version, but publishes only best_model.zip with no "
            "config and no eval protocol, so there is less to pin and nothing to reproduce"
        ),
    },
    {
        "repo_id": "crislmfroes/tqc-FetchPickAndPlace-v2",
        "algo": "TQC + HER, rl-zoo3",
        "licence": "none declared",
        "why_not_primary": "published mean_reward -12.70 +/- 12.81; the spread implies failed episodes at nominal",
    },
]

LICENCE_NOTE = {
    "declared_spdx": None,
    "status": "NOT DECLARED by the model repository",
    "checked": [
        "cardData.license is absent from the Hugging Face model metadata",
        "no license:* tag on the model repository",
        "no LICENSE file among the repository's files",
    ],
    "publisher": f"https://huggingface.co/{REPO_ID}",
    "survey": (
        "Every FetchPickAndPlace checkpoint found on the hub declares no licence: the six that were "
        "checked one by one (IntelliGrow/FetchPickAndPlace-v4, sb3/tqc-FetchPickAndPlace-v1, "
        "hhmm1122/fetch-pickandplace-sac-her, crislmfroes/tqc-FetchPickAndPlace-v2, "
        "Edgar404/td3-FetchPickAndPlaceDense-v2-v3, qgallouedec/tqc-FetchPickAndPlace-v1-3795610126) "
        "all have no license field, no license tag and no LICENSE file. This is the same position the "
        "humanoid target reached for Humanoid policies, and it is reported rather than papered over."
    ),
    "what_this_project_does": (
        "the weights are downloaded at run time and are NOT vendored, redistributed or modified; only "
        "their sha256 digests and the measured behaviour are published as evidence"
    ),
    "note_on_the_environment": (
        "the SCENE is a different matter and is properly licensed: Gymnasium-Robotics is MIT "
        "(Farama Foundation), and the Fetch MJCF it ships carries that licence"
    ),
    "alternatives_considered": ALTERNATIVES_CONSIDERED,
}

PROVENANCE_URL = f"https://huggingface.co/{REPO_ID}/tree/{REPO_REVISION}"

# Layer names inside the SB3 SAC state_dict that this module actually uses. The hidden depth
# is discovered from the checkpoint rather than assumed, so a differently shaped actor would
# be loaded correctly or rejected loudly, never silently truncated.
MU_KEYS = ("actor.mu.weight", "actor.mu.bias")
EXPECTED_HIDDEN_SIZES = (256, 256)
EXPECTED_OBS_DIM = 31
EXPECTED_ACT_DIM = 4

_CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "hf"


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _latent_keys(state: dict[str, np.ndarray]) -> list[str]:
    """`actor.latent_pi.<i>` indices present in the checkpoint, in forward order."""
    keys: list[str] = []
    i = 0
    while f"actor.latent_pi.{i}.weight" in state:
        keys.append(f"actor.latent_pi.{i}")
        i += 2  # SB3 interleaves Linear/activation, so weights sit at even indices
    return keys


def download_archive(allow_download: bool = True) -> Path:
    """Return the local path to the pinned SB3 archive, downloading it if needed.

    Set TAILBAZAAR_ARM_ARCHIVE to use a pre-fetched copy on an offline machine; the sha256
    check in `load_policy` applies either way, so an offline copy cannot quietly be a
    different file.
    """
    override = os.environ.get("TAILBAZAAR_ARM_ARCHIVE")
    if override:
        return Path(override)
    from huggingface_hub import hf_hub_download  # lazy: only needed on a cache miss

    return Path(
        hf_hub_download(
            repo_id=REPO_ID,
            filename=ARCHIVE_FILENAME,
            revision=REPO_REVISION,
            cache_dir=str(_CACHE_DIR),
            local_files_only=not allow_download,
        )
    )


class ArmPolicy:
    """The pinned SAC actor, evaluated deterministically in numpy."""

    def __init__(self, weights: dict[str, np.ndarray], digests: dict[str, str]) -> None:
        self.layers: list[tuple[np.ndarray, np.ndarray]] = []
        for key in _latent_keys(weights):
            W = np.ascontiguousarray(weights[f"{key}.weight"], dtype=np.float32)
            b = np.ascontiguousarray(weights[f"{key}.bias"], dtype=np.float32)
            self.layers.append((W, b))
        self.Wmu = np.ascontiguousarray(weights["actor.mu.weight"], dtype=np.float32)
        self.bmu = np.ascontiguousarray(weights["actor.mu.bias"], dtype=np.float32)
        self.digests = digests
        self.obs_dim = int(self.layers[0][0].shape[1])
        self.act_dim = int(self.Wmu.shape[0])
        self.hidden_sizes = tuple(int(b.size) for _, b in self.layers)
        self.actor_keys = tuple(
            [f"{k}.{s}" for k in _latent_keys(weights) for s in ("weight", "bias")] + list(MU_KEYS)
        )
        self.n_parameters = int(
            sum(w.size for W, b in self.layers for w in (W, b)) + self.Wmu.size + self.bmu.size
        )

    def observation_vector(self, obs: dict[str, np.ndarray]) -> np.ndarray:
        """SB3 CombinedExtractor: flatten each Dict entry and concatenate in sorted key order."""
        return np.concatenate([np.asarray(obs[k], dtype=np.float64).ravel() for k in OBS_KEY_ORDER])

    def action(self, obs_vec: np.ndarray, low: np.ndarray, high: np.ndarray) -> np.ndarray:
        """SB3 `predict(deterministic=True)` for a squashed-output Box action space."""
        x = np.asarray(obs_vec, dtype=np.float32)
        for W, b in self.layers:
            x = np.maximum(W @ x + b, 0.0, dtype=np.float32)
        squashed = np.tanh(self.Wmu @ x + self.bmu)
        return low + 0.5 * (squashed + 1.0) * (high - low)

    def identity(self) -> dict[str, Any]:
        """The pinned target identity that goes into every run document."""
        return {
            "policy_id": POLICY_ID,
            "algo": POLICY_ALGO,
            "algo_detail": POLICY_ALGO_DETAIL,
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
            "actor_layers": list(self.actor_keys),
            "obs_dim": self.obs_dim,
            "obs_key_order": list(OBS_KEY_ORDER),
            "obs_key_dims": list(OBS_KEY_DIMS),
            "action_dim": self.act_dim,
            "hidden_sizes": list(self.hidden_sizes),
            "activation": "relu",
            "feature_extractor": "CombinedExtractor (parameter-free: flatten + concat in sorted key order)",
            "evaluation": "deterministic mean action, tanh-squashed then unscaled to the action box",
            "evaluated_by": (
                "numpy reimplementation of stable_baselines3.SACPolicy.predict; torch is not a "
                "run-time dependency"
            ),
            "n_actor_parameters": self.n_parameters,
            "published_env_id": PUBLISHED_ENV_ID,
            "published_mean_reward": PUBLISHED_MEAN_REWARD,
            "published_std_reward": PUBLISHED_STD_REWARD,
            "published_eval_episodes": PUBLISHED_EVAL_EPISODES,
            "published_deterministic": PUBLISHED_DETERMINISTIC,
            "published_reward_is_the_publishers_claim_not_a_measurement_here": True,
            "licence": LICENCE_NOTE,
        }


_LOADED: ArmPolicy | None = None


def load_policy(allow_download: bool = True) -> ArmPolicy:
    """Download (once), verify every pinned hash and shape, and return the actor.

    Cached per process. Refuses to run if the archive, the weights, the layer names or the
    tensor shapes differ from the pins above.
    """
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
    if len(archive) != ARCHIVE_BYTES:
        raise ValueError(f"{ARCHIVE_FILENAME} is {len(archive)} bytes, pinned {ARCHIVE_BYTES}")
    raw = zipfile.ZipFile(io.BytesIO(archive)).read(WEIGHTS_MEMBER)
    weights_digest = _sha256(raw)
    if weights_digest != WEIGHTS_SHA256:
        raise ValueError(f"{WEIGHTS_MEMBER} sha256 {weights_digest} != pinned {WEIGHTS_SHA256}")
    state = read_torch_state_dict(raw)

    latent = _latent_keys(state)
    if not latent:
        raise ValueError("no actor.latent_pi.* tensors in the checkpoint")
    missing = [k for k in MU_KEYS if k not in state]
    if missing:
        raise ValueError(f"actor tensors missing from the checkpoint: {missing}")
    obs_dim = int(state[f"{latent[0]}.weight"].shape[1])
    act_dim = int(state["actor.mu.weight"].shape[0])
    hidden = tuple(int(state[f"{k}.weight"].shape[0]) for k in latent)
    if obs_dim != EXPECTED_OBS_DIM or act_dim != EXPECTED_ACT_DIM or hidden != EXPECTED_HIDDEN_SIZES:
        raise ValueError(
            f"actor shape {obs_dim}->{hidden}->{act_dim} != pinned "
            f"{EXPECTED_OBS_DIM}->{EXPECTED_HIDDEN_SIZES}->{EXPECTED_ACT_DIM}"
        )
    if obs_dim != sum(OBS_KEY_DIMS):
        raise ValueError(f"actor input width {obs_dim} != sum of Dict observation dims {OBS_KEY_DIMS}")

    # A digest over exactly the tensors used for control, so the evidence pins the bytes that
    # actually produced the trajectory rather than the whole file the critics also live in.
    keys = [f"{k}.{s}" for k in latent for s in ("weight", "bias")] + list(MU_KEYS)
    h = hashlib.sha256()
    for k in keys:
        arr = np.ascontiguousarray(state[k], dtype=np.float32)
        h.update(k.encode())
        h.update(str(arr.shape).encode())
        h.update(arr.tobytes())
    _LOADED = ArmPolicy(
        state,
        {"archive": archive_digest, "weights": weights_digest, "actor_tensors": h.hexdigest()},
    )
    return _LOADED
