import { useEffect, useState, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  LIST_MODES,
  CREATE_MODE,
  UPDATE_MODE,
  DELETE_MODE,
  RESET_MODE,
  Mode,
} from '@/shared/state/modesSlice';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { LIST_SKILLS } from '@/shared/backend-bridge/apps/skills';
import { ModeForm, emptyForm } from '../modesConstants';

export function useModes() {
  const dispatch = useAppDispatch();
  const { items, builtinDefaults, loading } = useAppSelector((s) => s.modes);
  const toolItems = useAppSelector((s) => s.tools.items);
  const modes = useMemo(() => Object.values(items), [items]);

  const mcpToolNames = useMemo(() => {
    return Object.values(toolItems)
      .filter((t) => t.mcp_config && Object.keys(t.mcp_config).length > 0 && t.auth_status !== 'none')
      .map((t) => `mcp:${t.name}`);
  }, [toolItems]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ModeForm>(emptyForm);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    dispatch(LIST_MODES());
    dispatch(fetchBuiltinTools());
    dispatch(fetchTools());
    dispatch(LIST_SKILLS());
  }, [dispatch]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (mode: Mode) => {
    setEditingId(mode.id);
    setForm({
      name: mode.name,
      description: mode.description,
      system_prompt: mode.system_prompt ?? '',
      tools: mode.tools ?? [],
      toolsEnabled: mode.tools !== null,
      default_next_mode: mode.default_next_mode ?? '',
      icon: mode.icon,
      color: mode.color,
      default_folder: mode.default_folder ?? '',
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const payload = {
      name: form.name,
      description: form.description,
      system_prompt: form.system_prompt || null,
      tools: form.toolsEnabled ? form.tools : null,
      default_next_mode: form.default_next_mode || null,
      icon: form.icon,
      color: form.color,
      default_folder: form.default_folder || null,
    };

    if (editingId) {
      await dispatch(UPDATE_MODE({ modeId: editingId, ...payload }));
    } else {
      await dispatch(CREATE_MODE(payload as any));
    }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await dispatch(DELETE_MODE(id));
  };

  const editingIsBuiltin = editingId ? items[editingId]?.is_builtin ?? false : false;

  const hasDiverged = useMemo(() => {
    if (!editingId || !editingIsBuiltin) return false;
    const defaults = builtinDefaults[editingId];
    if (!defaults) return false;
    const current = items[editingId];
    if (!current) return false;
    return (
      current.name !== defaults.name ||
      current.description !== defaults.description ||
      (current.system_prompt ?? '') !== (defaults.system_prompt ?? '') ||
      JSON.stringify(current.tools) !== JSON.stringify(defaults.tools) ||
      (current.default_next_mode ?? '') !== (defaults.default_next_mode ?? '') ||
      current.icon !== defaults.icon ||
      current.color !== defaults.color ||
      (current.default_folder ?? '') !== (defaults.default_folder ?? '')
    );
  }, [editingId, editingIsBuiltin, items, builtinDefaults]);

  const handleReset = async () => {
    if (!editingId) return;
    const action = await dispatch(RESET_MODE(editingId));
    if (RESET_MODE.fulfilled.match(action)) {
      const m = action.payload;
      setForm({
        name: m.name,
        description: m.description,
        system_prompt: m.system_prompt ?? '',
        tools: m.tools ?? [],
        toolsEnabled: m.tools !== null,
        default_next_mode: m.default_next_mode ?? '',
        icon: m.icon,
        color: m.color,
        default_folder: m.default_folder ?? '',
      });
    }
  };

  const otherModes = modes.filter((m) => m.id !== editingId);

  return {
    modes,
    items,
    loading,
    dialogOpen,
    setDialogOpen,
    editingId,
    form,
    setForm,
    browseOpen,
    setBrowseOpen,
    openCreate,
    openEdit,
    handleSave,
    handleDelete,
    editingIsBuiltin,
    hasDiverged,
    handleReset,
    otherModes,
    mcpToolNames,
  };
}
