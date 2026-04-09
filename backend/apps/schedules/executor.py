import logging
from backend.apps.schedules.models import Schedule

logger = logging.getLogger(__name__)


async def execute_schedule(schedule: Schedule):
    """Fire a schedule: create a new session or message an existing one."""
    if schedule.action_type == "new_session":
        await _create_new_session(schedule)
    elif schedule.action_type == "message_existing":
        await _message_existing(schedule)
    else:
        raise ValueError(f"Unknown action_type: {schedule.action_type}")


async def _create_new_session(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.models import AgentConfig

    config_kwargs: dict = {
        "dashboard_id": schedule.dashboard_id,
    }

    if schedule.template_id:
        try:
            from backend.apps.templates.templates import _load as load_template
            template = load_template(schedule.template_id)
            if template.mode:
                config_kwargs["mode"] = template.mode
        except Exception:
            logger.warning(f"Template {schedule.template_id} not found, using defaults")

    if schedule.model:
        config_kwargs["model"] = schedule.model
    if schedule.mode:
        config_kwargs["mode"] = schedule.mode
    if schedule.system_prompt:
        config_kwargs["system_prompt"] = schedule.system_prompt

    config = AgentConfig(**config_kwargs)
    session = await agent_manager.launch_agent(config)

    await agent_manager.send_message(
        session.id,
        schedule.prompt,
        mode=config_kwargs.get("mode"),
        model=config_kwargs.get("model"),
    )

    logger.info(f"Schedule {schedule.id} created session {session.id}")


async def _message_existing(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager

    if not schedule.target_session_id:
        raise ValueError("target_session_id required for message_existing action")

    if schedule.target_session_id not in agent_manager.sessions:
        raise ValueError(f"Session {schedule.target_session_id} not found or not active")

    await agent_manager.send_message(
        schedule.target_session_id,
        schedule.prompt,
    )

    logger.info(f"Schedule {schedule.id} sent message to session {schedule.target_session_id}")
