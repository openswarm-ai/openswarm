"""The one place an app stops being published (ENG-282).

Deleting an app and unpublishing it are different user actions that must reach the
same end state, and when they were written separately only one of them released the
publication: delete rmtree'd the workspace and dropped the record while the cloud row
stayed active, so the app was live at a URL its owner could no longer see. Measured on
1.7.8-exp.1 against prod, delete returned HTTP 200 and the public URL kept serving
byte-identical content.

Both paths now go through here, so a third deletion path cannot reintroduce the split.
Callers must treat a raised PublishError as fatal and destroy nothing: the record is
the only thing that still knows the slug.
"""
from typing import Any

from typeguard import typechecked

from backend.apps.outputs.models import Output
from backend.apps.outputs.publish_cloud import unpublish_from_cloud


@typechecked
async def release_publication(output: Output, settings: Any) -> bool:
    """Take the app off the internet and clear its publish state. False when it was never published."""
    if not output.published_slug:
        return False
    await unpublish_from_cloud(settings, output.published_slug)
    output.published_slug = None
    output.published_url = None
    output.publish_status = None
    output.publish_error = None
    return True
