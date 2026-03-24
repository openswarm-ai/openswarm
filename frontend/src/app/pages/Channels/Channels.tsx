import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PhoneIcon from '@mui/icons-material/Phone';
import SmsIcon from '@mui/icons-material/Sms';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SendIcon from '@mui/icons-material/Send';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  enableChannel,
  disableChannel,
  testChannel,
  fetchConversations,
  ChannelConfig,
} from '@/shared/state/channelsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CHANNEL_TYPE_ICONS: Record<string, React.ReactNode> = {
  sms: <SmsIcon />,
  whatsapp: <WhatsAppIcon />,
  voice: <PhoneIcon />,
};

const STATUS_COLORS: Record<string, string> = {
  active: '#4caf50',
  inactive: '#9e9e9e',
  error: '#f44336',
};

const Channels: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const channels = useAppSelector((s) => s.channels.items);
  const conversations = useAppSelector((s) => s.channels.conversations);
  const channelList = Object.values(channels).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState(0);

  // Create form
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'sms' | 'whatsapp' | 'voice'>('sms');
  const [newProvider, setNewProvider] = useState<'twilio' | 'telnyx'>('twilio');
  const [newPhone, setNewPhone] = useState('');
  const [newAccountSid, setNewAccountSid] = useState('');
  const [newAuthToken, setNewAuthToken] = useState('');

  // Test
  const [testNumber, setTestNumber] = useState('');
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    dispatch(fetchChannels());
  }, [dispatch]);

  const selected = selectedId ? channels[selectedId] : null;

  useEffect(() => {
    if (selectedId) dispatch(fetchConversations(selectedId));
  }, [selectedId, dispatch]);

  const handleCreate = async () => {
    const result = await dispatch(
      createChannel({
        name: newName,
        channel_type: newType,
        provider: newProvider,
        phone_number: newPhone,
        credentials: {
          account_sid: newAccountSid,
          auth_token: newAuthToken,
        },
      }),
    );
    if (createChannel.fulfilled.match(result)) {
      setSelectedId(result.payload.id);
      setCreateOpen(false);
      setNewName('');
      setNewPhone('');
      setNewAccountSid('');
      setNewAuthToken('');
    }
  };

  const handleDelete = async (id: string) => {
    await dispatch(deleteChannel(id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleTest = async () => {
    if (!selectedId || !testNumber) return;
    try {
      const result = await dispatch(testChannel({ id: selectedId, to_number: testNumber }));
      if (testChannel.fulfilled.match(result)) {
        setTestResult('Test sent successfully!');
      } else {
        setTestResult('Test failed');
      }
    } catch {
      setTestResult('Test failed');
    }
  };

  const convList = Object.values(conversations).filter(
    (cv) => cv.channel_id === selectedId,
  );

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Channel list */}
      <Box
        sx={{
          width: 320,
          flexShrink: 0,
          borderRight: `1px solid ${c.border.subtle}`,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: c.bg.secondary,
        }}
      >
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary }}>
            Channels
          </Typography>
          <Tooltip title="New channel">
            <IconButton
              size="small"
              onClick={() => setCreateOpen(true)}
              sx={{ color: c.accent.primary }}
            >
              <AddIcon />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ px: 1.5, pb: 1 }}>
          <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, lineHeight: 1.4 }}>
            Connect SMS, WhatsApp, or voice calls to your agents.
          </Typography>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto', px: 1 }}>
          {channelList.length === 0 && (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
                No channels configured yet
              </Typography>
            </Box>
          )}
          {channelList.map((ch) => (
            <Box
              key={ch.id}
              onClick={() => setSelectedId(ch.id)}
              sx={{
                p: 1.5,
                mb: 0.5,
                borderRadius: 2,
                cursor: 'pointer',
                bgcolor: selectedId === ch.id ? `${c.accent.primary}14` : 'transparent',
                border: selectedId === ch.id ? `1px solid ${c.accent.primary}40` : '1px solid transparent',
                '&:hover': { bgcolor: `${c.text.tertiary}0A` },
                transition: 'all 0.15s',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ color: c.text.muted }}>{CHANNEL_TYPE_ICONS[ch.channel_type]}</Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      color: c.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ch.name}
                  </Typography>
                  <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>
                    {ch.phone_number} · {ch.provider}
                  </Typography>
                </Box>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: STATUS_COLORS[ch.status] || '#9e9e9e',
                  }}
                />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Right: Detail panel */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        {!selected ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Typography sx={{ color: c.text.muted }}>Select a channel or create a new one</Typography>
          </Box>
        ) : (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
              <Box sx={{ color: c.text.muted, fontSize: 28 }}>{CHANNEL_TYPE_ICONS[selected.channel_type]}</Box>
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontSize: '1.2rem', fontWeight: 600, color: c.text.primary }}>
                  {selected.name}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
                  <Chip
                    label={selected.channel_type.toUpperCase()}
                    size="small"
                    sx={{ fontSize: '0.7rem', height: 22 }}
                  />
                  <Chip
                    label={selected.status}
                    size="small"
                    sx={{
                      fontSize: '0.7rem',
                      height: 22,
                      bgcolor: `${STATUS_COLORS[selected.status]}20`,
                      color: STATUS_COLORS[selected.status],
                    }}
                  />
                  <Chip label={`${selected.message_count} messages`} size="small" sx={{ fontSize: '0.7rem', height: 22 }} />
                </Box>
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                {selected.enabled ? (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<StopIcon />}
                    onClick={() => dispatch(disableChannel(selected.id))}
                    color="error"
                  >
                    Disable
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<PlayArrowIcon />}
                    onClick={() => dispatch(enableChannel(selected.id))}
                    sx={{ bgcolor: c.accent.primary }}
                  >
                    Enable
                  </Button>
                )}
                <IconButton size="small" onClick={() => handleDelete(selected.id)} sx={{ color: c.status.error }}>
                  <DeleteIcon />
                </IconButton>
              </Box>
            </Box>

            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: `1px solid ${c.border.subtle}` }}>
              <Tab label="Connection" sx={{ textTransform: 'none' }} />
              <Tab label="Agent" sx={{ textTransform: 'none' }} />
              <Tab label="Security" sx={{ textTransform: 'none' }} />
              {selected.channel_type === 'voice' && <Tab label="Voice" sx={{ textTransform: 'none' }} />}
              <Tab label="Conversations" sx={{ textTransform: 'none' }} />
              <Tab label="Test" sx={{ textTransform: 'none' }} />
            </Tabs>

            {/* Connection Tab */}
            {tab === 0 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <TextField
                  label="Phone Number"
                  value={selected.phone_number}
                  size="small"
                  onChange={(e) =>
                    dispatch(updateChannel({ id: selected.id, phone_number: e.target.value }))
                  }
                />
                <FormControl size="small">
                  <InputLabel>Provider</InputLabel>
                  <Select
                    value={selected.provider}
                    label="Provider"
                    onChange={(e) =>
                      dispatch(updateChannel({ id: selected.id, provider: e.target.value as any }))
                    }
                  >
                    <MenuItem value="twilio">Twilio</MenuItem>
                    <MenuItem value="telnyx">Telnyx</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  label="Account SID / API Key"
                  value={selected.credentials.account_sid || selected.credentials.api_key || ''}
                  size="small"
                  type="password"
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        credentials: {
                          ...selected.credentials,
                          [selected.provider === 'twilio' ? 'account_sid' : 'api_key']: e.target.value,
                        },
                      }),
                    )
                  }
                />
                <TextField
                  label="Auth Token / Public Key"
                  value={selected.credentials.auth_token || selected.credentials.public_key || ''}
                  size="small"
                  type="password"
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        credentials: {
                          ...selected.credentials,
                          [selected.provider === 'twilio' ? 'auth_token' : 'public_key']: e.target.value,
                        },
                      }),
                    )
                  }
                />
                <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mt: 1 }}>
                  Webhook URL for Twilio: <code>{window.location.origin.replace(/:\d+$/, ':8324')}/api/channels/webhooks/twilio/{selected.channel_type}?channel_id={selected.id}</code>
                </Typography>
              </Box>
            )}

            {/* Agent Tab */}
            {tab === 1 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <FormControl size="small">
                  <InputLabel>Mode</InputLabel>
                  <Select
                    value={selected.agent_config.mode}
                    label="Mode"
                    onChange={(e) =>
                      dispatch(
                        updateChannel({
                          id: selected.id,
                          agent_config: { ...selected.agent_config, mode: e.target.value },
                        }),
                      )
                    }
                  >
                    <MenuItem value="agent">Agent</MenuItem>
                    <MenuItem value="ask">Ask</MenuItem>
                    <MenuItem value="plan">Plan</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small">
                  <InputLabel>Model</InputLabel>
                  <Select
                    value={selected.agent_config.model}
                    label="Model"
                    onChange={(e) =>
                      dispatch(
                        updateChannel({
                          id: selected.id,
                          agent_config: { ...selected.agent_config, model: e.target.value },
                        }),
                      )
                    }
                  >
                    <MenuItem value="haiku">Haiku</MenuItem>
                    <MenuItem value="sonnet">Sonnet</MenuItem>
                    <MenuItem value="opus">Opus</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  label="System Prompt (optional)"
                  value={selected.agent_config.system_prompt || ''}
                  size="small"
                  multiline
                  rows={4}
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        agent_config: { ...selected.agent_config, system_prompt: e.target.value || undefined },
                      }),
                    )
                  }
                />
              </Box>
            )}

            {/* Security Tab */}
            {tab === 2 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={selected.security.verify_signatures}
                      onChange={(e) =>
                        dispatch(
                          updateChannel({
                            id: selected.id,
                            security: { ...selected.security, verify_signatures: e.target.checked },
                          }),
                        )
                      }
                    />
                  }
                  label="Verify webhook signatures"
                />
                <TextField
                  label="Allowlist (one phone per line)"
                  value={selected.security.allowlist.join('\n')}
                  size="small"
                  multiline
                  rows={4}
                  placeholder="+1234567890"
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        security: {
                          ...selected.security,
                          allowlist: e.target.value.split('\n').filter(Boolean),
                        },
                      }),
                    )
                  }
                />
                <TextField
                  label="Rate limit (per minute)"
                  value={selected.security.rate_limit_per_minute}
                  size="small"
                  type="number"
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        security: {
                          ...selected.security,
                          rate_limit_per_minute: parseInt(e.target.value) || 10,
                        },
                      }),
                    )
                  }
                />
              </Box>
            )}

            {/* Voice Tab */}
            {tab === 3 && selected.channel_type === 'voice' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <FormControl size="small">
                  <InputLabel>Call Mode</InputLabel>
                  <Select
                    value={selected.voice_config?.mode || 'conversation'}
                    label="Call Mode"
                    onChange={(e) =>
                      dispatch(
                        updateChannel({
                          id: selected.id,
                          voice_config: {
                            ...(selected.voice_config || {}),
                            mode: e.target.value,
                          } as any,
                        }),
                      )
                    }
                  >
                    <MenuItem value="conversation">Conversation (multi-turn)</MenuItem>
                    <MenuItem value="notify">Notify (one-shot)</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  label="Greeting Message"
                  value={selected.voice_config?.greeting_message || 'Hello, how can I help you?'}
                  size="small"
                  multiline
                  rows={2}
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        voice_config: {
                          ...(selected.voice_config || {}),
                          greeting_message: e.target.value,
                        } as any,
                      }),
                    )
                  }
                />
                <TextField
                  label="Voice (e.g. Polly.Joanna)"
                  value={selected.voice_config?.voice || 'Polly.Joanna'}
                  size="small"
                  onChange={(e) =>
                    dispatch(
                      updateChannel({
                        id: selected.id,
                        voice_config: {
                          ...(selected.voice_config || {}),
                          voice: e.target.value,
                        } as any,
                      }),
                    )
                  }
                />
              </Box>
            )}

            {/* Conversations Tab */}
            {tab === (selected.channel_type === 'voice' ? 4 : 3) && (
              <Box>
                {convList.length === 0 ? (
                  <Typography sx={{ color: c.text.muted }}>No conversations yet</Typography>
                ) : (
                  convList.map((conv) => (
                    <Box
                      key={conv.id}
                      sx={{
                        p: 2,
                        mb: 1,
                        borderRadius: 2,
                        border: `1px solid ${c.border.subtle}`,
                        bgcolor: c.bg.surface,
                      }}
                    >
                      <Typography sx={{ fontWeight: 500, fontSize: '0.85rem', color: c.text.primary }}>
                        {conv.phone_number}
                      </Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>
                        {conv.messages.length} messages · {conv.status}
                      </Typography>
                      <Box sx={{ mt: 1, maxHeight: 200, overflow: 'auto' }}>
                        {conv.messages.slice(-5).map((msg) => (
                          <Box
                            key={msg.id}
                            sx={{
                              p: 0.75,
                              mb: 0.5,
                              borderRadius: 1,
                              bgcolor: msg.direction === 'inbound' ? `${c.accent.primary}0A` : c.bg.secondary,
                              fontSize: '0.78rem',
                              color: c.text.primary,
                            }}
                          >
                            <Typography sx={{ fontSize: '0.65rem', color: c.text.muted, mb: 0.25 }}>
                              {msg.direction === 'inbound' ? 'Received' : 'Sent'} ·{' '}
                              {new Date(msg.timestamp).toLocaleTimeString()}
                            </Typography>
                            {msg.content}
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  ))
                )}
              </Box>
            )}

            {/* Test Tab */}
            {tab === (selected.channel_type === 'voice' ? 5 : 4) && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 500 }}>
                <TextField
                  label="Send test to phone number"
                  value={testNumber}
                  size="small"
                  placeholder="+1234567890"
                  onChange={(e) => setTestNumber(e.target.value)}
                />
                <Button
                  variant="contained"
                  startIcon={<SendIcon />}
                  onClick={handleTest}
                  sx={{ bgcolor: c.accent.primary, alignSelf: 'flex-start' }}
                >
                  Send Test
                </Button>
                {testResult && (
                  <Typography sx={{ fontSize: '0.85rem', color: testResult.includes('success') ? c.status.success : c.status.error }}>
                    {testResult}
                  </Typography>
                )}
              </Box>
            )}
          </>
        )}
      </Box>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>New Channel</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
          <TextField
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            size="small"
            placeholder="My SMS Channel"
          />
          <FormControl size="small">
            <InputLabel>Type</InputLabel>
            <Select value={newType} label="Type" onChange={(e) => setNewType(e.target.value as any)}>
              <MenuItem value="sms">SMS</MenuItem>
              <MenuItem value="whatsapp">WhatsApp</MenuItem>
              <MenuItem value="voice">Voice</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel>Provider</InputLabel>
            <Select value={newProvider} label="Provider" onChange={(e) => setNewProvider(e.target.value as any)}>
              <MenuItem value="twilio">Twilio</MenuItem>
              <MenuItem value="telnyx">Telnyx</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Phone Number"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            size="small"
            placeholder="+1234567890"
          />
          <TextField
            label="Account SID / API Key"
            value={newAccountSid}
            onChange={(e) => setNewAccountSid(e.target.value)}
            size="small"
            type="password"
          />
          <TextField
            label="Auth Token"
            value={newAuthToken}
            onChange={(e) => setNewAuthToken(e.target.value)}
            size="small"
            type="password"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!newName || !newPhone}
            sx={{ bgcolor: c.accent.primary }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Channels;
