"""Single point of truth for video object keys (video-tenant-storage R1/R2).

Every artifact save path MUST obtain its object key from
:func:`video_object_key`; no caller may hand-roll the ``tenants/...`` layout.
The tenant id is whitelist-validated so a hostile value can never produce a
path-traversal or prefix-escape key.
"""

from __future__ import annotations

import re

# Whitelist shared with the auth middleware / key-management script (R2).
_TENANT_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def validate_tenant_id(tenant_id: str) -> str:
    """Return *tenant_id* if it matches the whitelist, else raise ValueError."""
    if not isinstance(tenant_id, str) or not _TENANT_RE.match(tenant_id):
        raise ValueError(f"Invalid tenant_id: {tenant_id!r}")
    return tenant_id


def video_object_key(tenant_id: str, task_id: str) -> str:
    """Build the canonical object key ``tenants/{tenant_id}/videos/{task_id}.mp4``.

    Shares the ``tenants/{tid}/`` root prefix with the session side inside the
    ``oh-tenants`` bucket; this service only ever writes under its own
    ``videos/`` sub-prefix.
    """
    validate_tenant_id(tenant_id)
    return f"tenants/{tenant_id}/videos/{task_id}.mp4"
