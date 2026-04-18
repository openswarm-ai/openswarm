import { useEffect, useState, useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { 
  LIST_SKILLS, 
  CREATE_SKILL, 
  UPDATE_SKILL, 
  DELETE_SKILL, 
  REGISTRY_STATS,
  FETCH_ALL_REGISTRY_SKILLS,
  REGISTRY_DETAIL,
  RegistrySkill,
  RegistrySkillDetail,
  Skill 
} from '@/shared/backend-bridge/apps/skills';
import { SkillPreviewData } from '../SkillBuilderChat';
import { SkillForm, Selection, emptyForm } from '../skillsTypes';

export function useSkillsState() {
  const dispatch = useAppDispatch();
  const { items, loading } = useAppSelector((s) => s.skills);
  const {
    skills: regSkills,
    loading: regLoading,
    detail: regDetail,
    detailLoading: regDetailLoading,
  } = useAppSelector((s) => s.skillRegistry);
  const localSkills = Object.values(items);

  const [selection, setSelection] = useState<Selection>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [contentView, setContentView] = useState<'preview' | 'raw'>('preview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
  const [builderPreview, setBuilderPreview] = useState<SkillPreviewData | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const handleBuilderPreview = useCallback((data: SkillPreviewData | null) => {
    setBuilderPreview(data);
    if (data) {
      setSelection({ type: 'builder-preview' });
    } else if (selection?.type === 'builder-preview') {
      setSelection(null);
    }
  }, [selection]);

  const handleBuilderSaved = useCallback((message: string) => {
    setSnackbar({ open: true, message });
    dispatch(LIST_SKILLS());
  }, [dispatch]);

  useEffect(() => {
    dispatch(LIST_SKILLS());
    dispatch(FETCH_ALL_REGISTRY_SKILLS());
    dispatch(REGISTRY_STATS());
  }, [dispatch]);

  const regGrouped = useMemo(() => {
    const groups: Record<string, RegistrySkill[]> = {};
    const q = searchFilter.toLowerCase();
    for (const sk of regSkills) {
      if (q && !sk.name.toLowerCase().includes(q) && !sk.description.toLowerCase().includes(q)) continue;
      const cat = sk.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(sk);
    }
    return groups;
  }, [regSkills, searchFilter]);

  const filteredLocal = useMemo(() => {
    const q = searchFilter.toLowerCase();
    if (!q) return localSkills;
    return localSkills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [localSkills, searchFilter]);

  const categoryOrder = useMemo(() => Object.keys(regGrouped).sort(), [regGrouped]);

  const toggleCategory = (cat: string) =>
    setCollapsedCats((p) => ({ ...p, [cat]: !p[cat] }));

  const selectRegistry = (name: string) => {
    setSelection({ type: 'registry', name });
    dispatch(REGISTRY_DETAIL(name));
  };

  const selectLocal = (id: string) => {
    setSelection({ type: 'local', id });
  };

  const selectedLocal: Skill | null =
    selection?.type === 'local' ? items[selection.id] ?? null : null;
  const selectedReg: RegistrySkillDetail | null =
    selection?.type === 'registry' && regDetail?.name === selection.name ? regDetail : null;

  const showLoadingSpinner = (loading || regLoading) && regSkills.length === 0 && localSkills.length === 0;

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setForm({ name: skill.name, description: skill.description, content: skill.content, command: skill.command });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (editingId) {
      await dispatch(UPDATE_SKILL({ skillId: editingId, ...form }));
    } else {
      await dispatch(CREATE_SKILL(form));
    }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await dispatch(DELETE_SKILL(id));
    if (selection?.type === 'local' && selection.id === id) setSelection(null);
  };

  const handleInstall = async () => {
    if (!selectedReg) return;
    await dispatch(CREATE_SKILL({
      name: selectedReg.name,
      description: selectedReg.description,
      content: selectedReg.content,
      command: selectedReg.name.toLowerCase().replace(/\s+/g, '-'),
    }));
    setSnackbar({ open: true, message: `Installed "${selectedReg.name}" as a local skill` });
  };

  const handleEditInstall = () => {
    if (!selectedReg) return;
    setEditingId(null);
    setForm({
      name: selectedReg.name,
      description: selectedReg.description,
      content: selectedReg.content,
      command: selectedReg.name.toLowerCase().replace(/\s+/g, '-'),
    });
    setDialogOpen(true);
  };

  const isSelected = (type: 'registry' | 'local', key: string) => {
    if (!selection) return false;
    if (type === 'registry') return selection.type === 'registry' && selection.name === key;
    return selection.type === 'local' && selection.id === key;
  };

  return {
    selection, searchFilter, setSearchFilter,
    collapsedCats, toggleCategory,
    contentView, setContentView,
    dialogOpen, setDialogOpen,
    editingId, form, setForm,
    snackbar, setSnackbar,
    builderPreview, builderOpen, setBuilderOpen,
    filteredLocal, regGrouped, categoryOrder,
    regDetailLoading, selectedLocal, selectedReg,
    showLoadingSpinner,
    selectRegistry, selectLocal, isSelected,
    openCreate, openEdit, handleSave, handleDelete,
    handleInstall, handleEditInstall,
    handleBuilderPreview, handleBuilderSaved,
  };
}
