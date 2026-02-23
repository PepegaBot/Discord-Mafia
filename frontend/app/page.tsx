'use client';

import {
  DiscordSDK,
  patchUrlMappings,
  type CommandResponse,
  type IDiscordSDK,
} from '@discord/embedded-app-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type GamePhase = 'LOBBY' | 'ROLE_ASSIGNMENT' | 'NIGHT_PHASE' | 'DAY_PHASE' | 'VOTING' | 'RESOLUTION';
type GameRole = 'الراوي' | 'المافيا' | 'المواطن' | 'المحقق' | 'الطبيب' | null;
type WinnerAlignment = 'MAFIA' | 'CITIZEN' | null;

type RoomSettings = { mafiaCount: number; doctorCount: number; detectiveCount: number };
type RoomRequirements = {
  specialRoles: number;
  minimumCitizens: number;
  minimumParticipants: number;
  minimumPlayers: number;
};

type PlayerView = {
  id: string;
  discordId: string;
  username: string;
  avatar: string | null;
  isAlive: boolean;
  isReady: boolean;
  isHost: boolean;
  role: GameRole;
  roleHint: GameRole;
};

type NightData = {
  requiredCount: number;
  submittedCount: number;
  selfSelectionTargetId: string | null;
  selfSubmitted: boolean;
  mafiaSelections: Array<{ mafiaId: string; targetId: string }> | null;
};

type ResolutionPayload = {
  type: 'NIGHT_RESULT' | 'VOTE_RESULT' | 'FORFEIT_RESULT';
  round: number;
  story?: string;
  forced?: boolean;
  killedPlayerId?: string | null;
  savedPlayerId?: string | null;
  detectiveDidInvestigate?: boolean;
  tallies?: Record<string, number>;
  eliminatedPlayerId?: string | null;
  tiedPlayerIds?: string[];
  winner?: WinnerAlignment;
};

type RoomState = {
  roomId: string;
  phase: GamePhase;
  round: number;
  winner: WinnerAlignment;
  self: {
    id: string;
    discordId: string;
    username: string;
    avatar: string | null;
    role: GameRole;
    isAlive: boolean;
    isReady: boolean;
    isHost: boolean;
  } | null;
  players: PlayerView[];
  settings: RoomSettings;
  requirements: RoomRequirements;
  votes: Record<string, number>;
  night: NightData;
  lastResolution: ResolutionPayload | null;
};

type UserProfile = { id: string; username: string; displayName: string; avatar: string | null };
type DetectResult = { targetId: string; targetName: string; alignment: 'MAFIA' | 'CITIZEN' };
type AuthResponse = CommandResponse<'authenticate'>;

const DISCORD_CLIENT_ID = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID || '';
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';
const BACKEND_MAPPING_PREFIX = process.env.NEXT_PUBLIC_BACKEND_MAPPING_PREFIX || '/backend';
const RAW_URL_MAPPINGS = process.env.NEXT_PUBLIC_URL_MAPPINGS || '';

const PHASE_LABELS: Record<GamePhase, string> = {
  LOBBY: 'اللوبي',
  ROLE_ASSIGNMENT: 'توزيع الأدوار',
  NIGHT_PHASE: 'الليل',
  DAY_PHASE: 'النهار',
  VOTING: 'التصويت',
  RESOLUTION: 'النتيجة',
};

const ROLE_ACCENTS: Record<string, string> = {
  default: '#F5D13B',
  الراوي: '#BCAFA2',
  المافيا: '#8B0000',
  المواطن: '#F5D13B',
  المحقق: '#2B3A4A',
  الطبيب: '#4C7A5D',
};

const WINNER_LABELS: Record<string, string> = { MAFIA: 'فوز المافيا', CITIZEN: 'فوز المواطنين' };
const LIMITS: Record<keyof RoomSettings, { min: number; max: number }> = {
  mafiaCount: { min: 1, max: 6 },
  doctorCount: { min: 0, max: 4 },
  detectiveCount: { min: 0, max: 4 },
};

function isAbsoluteHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function normalizePrefix(prefix: string) {
  const cleaned = `/${prefix}`.replace(/\/+/, '/').replace(/\/+/g, '/');
  return cleaned.endsWith('/') && cleaned.length > 1 ? cleaned.slice(0, -1) : cleaned;
}

function backendBaseFor(isEmbedded: boolean) {
  return isEmbedded ? normalizePrefix(BACKEND_MAPPING_PREFIX) : BACKEND_URL;
}

function parseMappings(raw: string) {
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [prefix, target] = entry.split('|').map((v) => v?.trim());
      return { prefix, target };
    })
    .filter((v): v is { prefix: string; target: string } => Boolean(v.prefix && v.target));
}

function avatarFromAuthUser(user: AuthResponse['user'] | undefined | null) {
  if (!user) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  const discriminator = Number(user.discriminator || 0) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${discriminator}.png`;
}

function playerNameById(players: PlayerView[], playerId?: string | null) {
  if (!playerId) return null;
  return players.find((p) => p.id === playerId)?.username || null;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function skipButtonLabel(phase?: GamePhase) {
  switch (phase) {
    case 'ROLE_ASSIGNMENT':
      return 'تخطي توزيع الأدوار';
    case 'NIGHT_PHASE':
      return 'إنهاء الليل الآن';
    case 'DAY_PHASE':
      return 'تخطي النقاش وفتح التصويت';
    case 'VOTING':
      return 'إنهاء التصويت الآن';
    case 'RESOLUTION':
      return 'متابعة سريعة';
    default:
      return 'تخطي';
  }
}

export default function Page() {
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [voiceChannelName, setVoiceChannelName] = useState('...');
  const [roomId, setRoomId] = useState('');
  const [manualRoomId, setManualRoomId] = useState('');
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [detectiveResult, setDetectiveResult] = useState<DetectResult | null>(null);

  const sdkRef = useRef<IDiscordSDK | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const mappingsPatchedRef = useRef(false);

  const pushNotice = useCallback((message: string) => {
    if (!message) return;
    setNotices((current) => [message, ...current].slice(0, 6));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initDiscord = async () => {
      try {
        const embedded = new URLSearchParams(window.location.search).get('frame_id') !== null;
        setIsEmbedded(embedded);

        if (!embedded) {
          const storedId = window.sessionStorage.getItem('local_profile_id') || `local-${crypto.randomUUID()}`;
          window.sessionStorage.setItem('local_profile_id', storedId);
          if (!cancelled) {
            setProfile({
              id: storedId,
              username: `Local-${storedId.slice(-4)}`,
              displayName: `لاعب محلي ${storedId.slice(-4)}`,
              avatar: null,
            });
            setVoiceChannelName('وضع تطوير محلي');
            setRoomId('local-mafia-room');
            setManualRoomId('local-mafia-room');
            setAuthState('authenticated');
          }
          return;
        }

        if (!DISCORD_CLIENT_ID) throw new Error('NEXT_PUBLIC_DISCORD_CLIENT_ID is missing.');

        if (!mappingsPatchedRef.current) {
          const mappings = parseMappings(RAW_URL_MAPPINGS);
          if (mappings.length > 0) patchUrlMappings(mappings);
          mappingsPatchedRef.current = true;
        }

        const discordSdk = new DiscordSDK(DISCORD_CLIENT_ID, { disableConsoleLogOverride: true });
        sdkRef.current = discordSdk;
        await discordSdk.ready();

        const { code } = await discordSdk.commands.authorize({
          client_id: DISCORD_CLIENT_ID,
          response_type: 'code',
          state: '',
          prompt: 'none',
          scope: ['identify', 'applications.commands', 'rpc.voice.read'],
        });

        const tokenResponse = await fetch('/api/discord/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);

        const tokenPayload = await tokenResponse.json();
        if (!tokenPayload.access_token) throw new Error('Backend token endpoint did not return access_token.');

        const auth = await discordSdk.commands.authenticate({ access_token: tokenPayload.access_token });
        if (!auth?.user) throw new Error('Discord SDK authenticate returned no user payload.');

        let resolvedProfile: UserProfile = {
          id: auth.user.id,
          username: auth.user.username,
          displayName: auth.user.global_name || auth.user.username,
          avatar: avatarFromAuthUser(auth.user),
        };

        try {
          const meResponse = await fetch('/api/discord/me', {
            headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
          });
          if (meResponse.ok) {
            const meData = await meResponse.json();
            resolvedProfile = {
              id: meData.id,
              username: meData.username || resolvedProfile.username,
              displayName: meData.displayName || resolvedProfile.displayName,
              avatar: meData.avatar || resolvedProfile.avatar,
            };
          }
        } catch {
          // fallback to authenticate payload
        }

        let channelName = 'القناة الصوتية';
        if (discordSdk.channelId && discordSdk.guildId) {
          try {
            const channel = await discordSdk.commands.getChannel({ channel_id: discordSdk.channelId });
            channelName = channel.name || channelName;
          } catch {
            // no-op
          }
        }

        if (!cancelled) {
          setProfile(resolvedProfile);
          setVoiceChannelName(channelName);
          const derivedRoomId = discordSdk.channelId || `maf-${resolvedProfile.id.slice(-6)}`;
          setRoomId(derivedRoomId);
          setManualRoomId(derivedRoomId);
          setAuthState('authenticated');
        }
      } catch (error) {
        if (!cancelled) {
          setAuthState('error');
          setAuthError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    initDiscord();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated' || !profile || !roomId) return;

    const base = backendBaseFor(isEmbedded);
    const socket = isAbsoluteHttpUrl(base)
      ? io(base, { path: '/socket.io', transports: ['websocket'], withCredentials: true })
      : io({ path: `${normalizePrefix(base)}/socket.io`, transports: ['websocket'] });

    socketRef.current = socket;
    setConnectionState('connecting');

    socket.on('connect', () => {
      setConnectionState('connected');
      socket.emit('join_room', { roomId, profile });
    });

    socket.on('disconnect', () => setConnectionState('disconnected'));
    socket.on('connect_error', (error) => {
      setConnectionState('disconnected');
      pushNotice(`تعذّر الاتصال بالخادم: ${error.message}`);
    });
    socket.on('room_state', (payload: RoomState) => setRoomState(payload));
    socket.on('system_notice', (payload: { message?: string }) => payload?.message && pushNotice(payload.message));
    socket.on('game_error', (payload: { message?: string }) => payload?.message && pushNotice(payload.message));
    socket.on('detective_result', (payload: DetectResult) => {
      setDetectiveResult(payload);
      pushNotice(`نتيجة التحقيق: ${payload.targetName} => ${payload.alignment === 'MAFIA' ? 'مافيا' : 'مواطن'}`);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnectionState('disconnected');
      setRoomState(null);
      setDetectiveResult(null);
    };
  }, [authState, isEmbedded, profile, pushNotice, roomId]);

  useEffect(() => {
    if (roomState?.phase !== 'NIGHT_PHASE') setDetectiveResult(null);
  }, [roomState?.phase]);

  const emitEvent = useCallback(
    (event: string, payload: Record<string, unknown> = {}) => {
      if (!socketRef.current || connectionState !== 'connected') {
        pushNotice('الاتصال غير جاهز حالياً.');
        return;
      }
      socketRef.current.emit(event, { roomId, ...payload });
    },
    [connectionState, pushNotice, roomId],
  );

  const players = roomState?.players || [];
  const self = roomState?.self || null;
  const selfRole = self?.role || null;
  const accent = ROLE_ACCENTS[selfRole || 'default'] || ROLE_ACCENTS.default;
  const participants = useMemo(() => players.filter((p) => !p.isHost), [players]);
  const readyParticipants = useMemo(() => participants.filter((p) => p.isReady).length, [participants]);

  const settings = roomState?.settings || { mafiaCount: 1, doctorCount: 1, detectiveCount: 1 };
  const requirements = roomState?.requirements || {
    specialRoles: 3,
    minimumCitizens: 1,
    minimumParticipants: 4,
    minimumPlayers: 5,
  };

  const currentCitizenCount = Math.max(0, participants.length - requirements.specialRoles);
  const aliveTargets = useMemo(() => players.filter((p) => p.isAlive && !p.isHost), [players]);
  const isSleepingCitizen = roomState?.phase === 'NIGHT_PHASE' && selfRole === 'المواطن' && Boolean(self?.isAlive);

  const mafiaLiveSelections = useMemo(() => {
    if (!roomState?.night.mafiaSelections) return [];
    return roomState.night.mafiaSelections.map((item) => ({
      mafiaName: playerNameById(players, item.mafiaId) || 'عضو مافيا',
      targetName: playerNameById(players, item.targetId) || 'هدف غير معروف',
    }));
  }, [players, roomState?.night.mafiaSelections]);

  const resolutionText = useMemo(() => {
    const result = roomState?.lastResolution;
    if (!result) return null;
    if (result.story) return result.story;
    if (result.type === 'NIGHT_RESULT') {
      if (result.killedPlayerId) return `سقط في الليل: ${playerNameById(players, result.killedPlayerId) || 'لاعب'}`;
      if (result.savedPlayerId) return `تم إنقاذ: ${playerNameById(players, result.savedPlayerId) || 'لاعب'}`;
      return 'مرّ الليل دون ضحايا.';
    }
    if (result.type === 'VOTE_RESULT') {
      if (result.eliminatedPlayerId) return `تم إقصاء: ${playerNameById(players, result.eliminatedPlayerId) || 'لاعب'}`;
      return 'تعادل التصويت ولم يتم إقصاء أي لاعب.';
    }
    return 'تم إنهاء الجولة بسبب انسحاب/انقطاع أحد اللاعبين.';
  }, [players, roomState?.lastResolution]);

  const canHostControl = Boolean(self?.isHost || self?.role === 'الراوي');

  const updateRoomSetting = useCallback(
    (key: keyof RoomSettings, delta: number) => {
      if (!roomState || roomState.phase !== 'LOBBY' || !canHostControl) return;
      const limits = LIMITS[key];
      const nextValue = clampNumber(roomState.settings[key] + delta, limits.min, limits.max);
      if (nextValue === roomState.settings[key]) return;
      emitEvent('update_room_settings', { settings: { ...roomState.settings, [key]: nextValue } });
    },
    [canHostControl, emitEvent, roomState],
  );

  const skipLabel = skipButtonLabel(roomState?.phase);

  if (authState === 'loading') {
    return (
      <main className="min-h-screen grid place-items-center p-6">
        <section className="deco-shell w-full max-w-md rounded-2xl p-6 text-center">
          <h1 className="font-display text-3xl">تحميل النشاط</h1>
          <p className="mt-2 text-sm text-[#B9B3A7]">جاري تهيئة Discord SDK والتحقق من الهوية...</p>
        </section>
      </main>
    );
  }

  if (authState === 'error' || !profile) {
    return (
      <main className="min-h-screen grid place-items-center p-6">
        <section className="deco-shell w-full max-w-xl rounded-2xl p-6">
          <h1 className="font-display text-3xl text-[#8B0000]">فشل التهيئة</h1>
          <p className="mt-3 text-sm leading-relaxed text-[#E6E1D5]">{authError || 'تعذر مصادقة Discord.'}</p>
          <p className="mt-2 text-xs text-[#B9B3A7]">
            تأكد من إعداد `NEXT_PUBLIC_DISCORD_CLIENT_ID` و `NEXT_PUBLIC_BACKEND_MAPPING_PREFIX` و `NEXT_PUBLIC_URL_MAPPINGS` بالإضافة إلى `DISCORD_CLIENT_ID` و `DISCORD_CLIENT_SECRET` في Vercel.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 md:p-8" style={{ '--accent': accent } as React.CSSProperties}>
      {isSleepingCitizen ? (
        <div className="sleep-overlay">
          <div className="sleep-core">
            <div className="text-center">
              <p className="font-display text-4xl text-[#F5D13B]">ليل</p>
              <p className="mt-2 text-lg font-semibold">أنت نائم الآن...</p>
              <p className="mt-1 text-sm text-[#B9B3A7]">انتظر حتى يبدأ النهار</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-7xl">
        <header className="deco-shell rounded-2xl p-4 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl md:text-4xl">مافيا Tha Basement</h1>
                <span className="status-chip rounded-full">رمضان كريم 🌙</span>
              </div>
              <p className="mt-1 text-sm text-[#B9B3A7]">القناة: {voiceChannelName}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="status-chip rounded-full">المرحلة: {roomState ? PHASE_LABELS[roomState.phase] : '...'}</span>
              <span className="status-chip rounded-full">الجولة: {roomState?.round || 0}</span>
              <span className="status-chip rounded-full">
                الاتصال: {connectionState === 'connected' ? 'متصل' : connectionState === 'connecting' ? 'جاري...' : 'غير متصل'}
              </span>
            </div>
          </div>

          <div className="accent-line mt-4" />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="h-10 w-10 overflow-hidden rounded-full border border-white/20 bg-[#171717]">
              {profile.avatar ? (
                <img src={profile.avatar} alt={profile.displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-xs">صورة</div>
              )}
            </div>
            <div>
              <p className="text-sm font-semibold">{profile.displayName}</p>
              <p className="text-xs text-[#B9B3A7]">@{profile.username}</p>
            </div>
            <div className="mr-auto text-sm text-[#B9B3A7]">الغرفة: {roomState?.roomId || roomId}</div>
          </div>
        </header>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <article className="deco-shell rounded-2xl p-4 md:p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl">اللاعبون</h2>
              <span className="text-xs text-[#B9B3A7]">{players.length} مشاركين</span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {players.map((player) => {
                const votesForPlayer = roomState?.votes?.[player.id] || 0;
                return (
                  <div key={player.id} className={`role-card rounded-xl p-3 ${player.isAlive ? 'alive' : ''}`}>
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 overflow-hidden rounded-full border border-white/15 bg-black/40">
                        {player.avatar ? (
                          <img src={player.avatar} alt={player.username} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-xs">صورة</div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{player.username}</p>
                        <p className="text-xs text-[#B9B3A7]">{player.isHost ? 'الراوي / Admin' : player.isAlive ? 'حي' : 'خارج اللعبة'}</p>
                        {player.role ? <p className="mt-1 text-xs text-[#D5CFBF]">{player.role}</p> : null}
                      </div>
                      {roomState?.phase === 'VOTING' ? (
                        <span className="rounded-full border border-white/20 px-2 py-1 text-xs">{votesForPlayer}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>

          <aside className="deco-shell rounded-2xl p-4 md:p-6">
            <h2 className="font-display text-2xl">لوحة التحكم</h2>
            <p className="mt-1 text-sm text-[#B9B3A7]">دورك: {selfRole || '...'}</p>

            {!isEmbedded ? (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/25 p-3">
                <p className="mb-2 text-xs text-[#B9B3A7]">وضع تطوير محلي</p>
                <div className="flex gap-2">
                  <input
                    value={manualRoomId}
                    onChange={(event) => setManualRoomId(event.target.value)}
                    className="w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    placeholder="معرّف الغرفة"
                  />
                  <button
                    className="action-btn w-auto min-w-[110px] rounded-lg"
                    onClick={() => {
                      const next = manualRoomId.trim();
                      if (next) setRoomId(next);
                    }}
                  >
                    تبديل الغرفة
                  </button>
                </div>
              </div>
            ) : null}

            {roomState ? (
              <div className="mt-4 rounded-lg border border-white/15 bg-black/30 p-3 text-sm">
                <p className="font-semibold">إعدادات الغرفة</p>
                <p className="mt-1 text-xs text-[#B9B3A7]">مافيا: {settings.mafiaCount} | طبيب: {settings.doctorCount} | محقق: {settings.detectiveCount}</p>
                <p className="mt-1 text-xs text-[#B9B3A7]">الحد الأدنى: {requirements.minimumPlayers} لاعبين (راوي + {requirements.minimumParticipants} مشاركين)</p>
                <p className="mt-1 text-xs text-[#B9B3A7]">مواطنون حاليون: {currentCitizenCount}</p>

                {canHostControl && roomState.phase === 'LOBBY' ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                      <span>عدد المافيا</span>
                      <div className="flex items-center gap-2">
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('mafiaCount', -1)}>-</button>
                        <span>{settings.mafiaCount}</span>
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('mafiaCount', 1)}>+</button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                      <span>عدد الأطباء</span>
                      <div className="flex items-center gap-2">
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('doctorCount', -1)}>-</button>
                        <span>{settings.doctorCount}</span>
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('doctorCount', 1)}>+</button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                      <span>عدد المحققين</span>
                      <div className="flex items-center gap-2">
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('detectiveCount', -1)}>-</button>
                        <span>{settings.detectiveCount}</span>
                        <button className="rounded border border-white/20 px-2 py-1" onClick={() => updateRoomSetting('detectiveCount', 1)}>+</button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              {roomState?.phase === 'LOBBY' ? (
                <>
                  <div className="rounded-lg border border-white/15 bg-black/30 p-3 text-xs text-[#B9B3A7]">
                    الجاهزية: {readyParticipants}/{participants.length} (بدون الراوي)
                  </div>
                  {!self?.isHost ? (
                    <button className="action-btn rounded-lg" onClick={() => emitEvent('set_ready', { ready: !self?.isReady })}>
                      {self?.isReady ? 'إلغاء الجاهزية' : 'جاهز'}
                    </button>
                  ) : null}
                  {canHostControl ? (
                    <button className="action-btn rounded-lg" onClick={() => emitEvent('start_game')}>
                      بدء اللعبة
                    </button>
                  ) : null}
                </>
              ) : null}

              {roomState?.phase === 'NIGHT_PHASE' && self?.isAlive ? (
                <>
                  {selfRole === 'المافيا' ? (
                    <>
                      <p className="text-xs text-[#B9B3A7]">اختر هدف القتل. يظهر اختيار المافيا للمافيا فوراً.</p>
                      {aliveTargets.filter((player) => player.id !== self.id).map((player) => (
                        <button
                          key={`kill-${player.id}`}
                          className="action-btn rounded-lg"
                          style={roomState.night.selfSelectionTargetId === player.id ? { borderColor: 'var(--accent)', background: 'rgba(255,255,255,0.06)' } : undefined}
                          onClick={() => emitEvent('kill_target', { targetId: player.id })}
                        >
                          اغتيال {player.username}
                        </button>
                      ))}

                      {mafiaLiveSelections.length > 0 ? (
                        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
                          <p className="text-xs text-[#B9B3A7]">أهداف أعضاء المافيا:</p>
                          <div className="mt-2 space-y-1 text-sm">
                            {mafiaLiveSelections.map((entry) => (
                              <p key={`${entry.mafiaName}-${entry.targetName}`}>{entry.mafiaName} ⟶ {entry.targetName}</p>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {selfRole === 'الطبيب' ? (
                    <>
                      <p className="text-xs text-[#B9B3A7]">اختر لاعباً لإنقاذه هذه الليلة:</p>
                      {aliveTargets.map((player) => (
                        <button
                          key={`heal-${player.id}`}
                          className="action-btn rounded-lg"
                          style={roomState.night.selfSelectionTargetId === player.id ? { borderColor: 'var(--accent)', background: 'rgba(255,255,255,0.06)' } : undefined}
                          onClick={() => emitEvent('heal_target', { targetId: player.id })}
                        >
                          حماية {player.username}
                        </button>
                      ))}
                    </>
                  ) : null}

                  {selfRole === 'المحقق' ? (
                    <>
                      <p className="text-xs text-[#B9B3A7]">اختر هدف التحقيق:</p>
                      {aliveTargets.filter((player) => player.id !== self.id).map((player) => (
                        <button
                          key={`investigate-${player.id}`}
                          className="action-btn rounded-lg"
                          style={roomState.night.selfSelectionTargetId === player.id ? { borderColor: 'var(--accent)', background: 'rgba(255,255,255,0.06)' } : undefined}
                          onClick={() => emitEvent('investigate_target', { targetId: player.id })}
                        >
                          تحقيق مع {player.username}
                        </button>
                      ))}

                      {detectiveResult ? (
                        <div className="rounded-lg border border-white/15 bg-black/35 p-3 text-sm">
                          {detectiveResult.targetName}: {detectiveResult.alignment === 'MAFIA' ? 'مافيا' : 'مواطن'}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {roomState.night.selfSubmitted && selfRole !== 'الراوي' ? (
                    <div className="rounded-lg border border-white/15 bg-black/30 p-3 text-xs text-[#B9B3A7]">
                      تم إرسال قرارك الليلي. يمكنك تغييره حتى ينهي الراوي الليل أو يكتمل الجميع.
                    </div>
                  ) : null}

                  {selfRole === 'الراوي' ? (
                    <div className="rounded-lg border border-white/15 bg-black/30 p-3 text-sm">
                      اكتملت الأدوار الليلية: {roomState.night.submittedCount}/{roomState.night.requiredCount}
                    </div>
                  ) : null}
                </>
              ) : null}

              {roomState?.phase === 'DAY_PHASE' ? (
                <>
                  <div className="rounded-lg border border-white/15 bg-black/30 p-3 text-sm">
                    <p className="font-semibold">سرد الراوي</p>
                    <p className="mt-1">{resolutionText || 'مرحلة النقاش النهاري فعّالة.'}</p>
                  </div>
                  {canHostControl ? (
                    <button className="action-btn rounded-lg" onClick={() => emitEvent('begin_voting')}>
                      فتح التصويت
                    </button>
                  ) : null}
                </>
              ) : null}

              {roomState?.phase === 'VOTING' && self?.isAlive && selfRole !== 'الراوي' ? (
                <>
                  <p className="text-xs text-[#B9B3A7]">صوّت على اللاعب المشبوه. يتم تحديث العدّاد مباشرة.</p>
                  {aliveTargets.map((player) => {
                    const votes = roomState.votes[player.id] || 0;
                    return (
                      <button key={`vote-${player.id}`} className="action-btn rounded-lg" onClick={() => emitEvent('cast_vote', { targetId: player.id })}>
                        تصويت ضد {player.username} ({votes})
                      </button>
                    );
                  })}
                </>
              ) : null}

              {roomState?.phase === 'RESOLUTION' ? (
                <>
                  <div className="rounded-lg border border-white/15 bg-black/30 p-3 text-sm">
                    <p className="font-semibold">نتيجة الجولة</p>
                    <p className="mt-1">{resolutionText}</p>
                    {roomState.winner ? <p className="mt-2 font-semibold text-[#F5D13B]">{WINNER_LABELS[roomState.winner]}</p> : null}
                  </div>

                  {canHostControl && !roomState.winner ? (
                    <button className="action-btn rounded-lg" onClick={() => emitEvent('next_round')}>
                      بدء ليلة جديدة
                    </button>
                  ) : null}

                  {canHostControl ? (
                    <button className="action-btn rounded-lg" onClick={() => emitEvent('restart_game')}>
                      إعادة اللعبة
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>

            {canHostControl && roomState && roomState.phase !== 'LOBBY' ? (
              <div className="mt-4 space-y-2 rounded-lg border border-white/15 bg-black/30 p-3">
                <p className="text-xs text-[#B9B3A7]">تحكم الراوي</p>
                <button className="action-btn rounded-lg" onClick={() => emitEvent('skip_phase')}>
                  {skipLabel}
                </button>
              </div>
            ) : null}
          </aside>
        </section>

        {notices.length > 0 ? (
          <section className="deco-shell mt-4 rounded-2xl p-4">
            <h3 className="font-display text-xl">تنبيهات</h3>
            <div className="mt-2 space-y-1 text-sm text-[#D9D2C4]">
              {notices.map((notice, index) => (
                <p key={`${notice}-${index}`}>{notice}</p>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
