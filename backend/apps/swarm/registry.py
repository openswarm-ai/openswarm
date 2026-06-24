"""Maps an EntityType to the Exportable that handles it, and the leaves-first
order import walks. Adding a shareable type is one entry here plus its module."""
from .entities.apps import AppExportable
from .entities.dashboards import DashboardExportable
from .entities.modes import ModeExportable
from .entities.SessionExportable import SessionExportable
from .entities.skills import SkillExportable
from .entities.workflows import WorkflowExportable
from .models import EntityType

REGISTRY: dict[EntityType, type] = {
    EntityType.skill: SkillExportable,
    EntityType.app: AppExportable,
    EntityType.workflow: WorkflowExportable,
    EntityType.mode: ModeExportable,
    EntityType.session: SessionExportable,
    EntityType.dashboard: DashboardExportable,
}

# Leaves first: a dependency must import before whatever references it.
IMPORT_ORDER = [
    EntityType.skill,
    EntityType.mode,
    EntityType.session,
    EntityType.app,
    EntityType.workflow,
    EntityType.dashboard,
]


def get_exportable(etype: EntityType) -> type | None:
    return REGISTRY.get(etype)
