require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID?.trim();
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET?.trim();
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI?.trim();

const PHASES = Object.freeze({
  LOBBY: 'LOBBY',
  ROLE_ASSIGNMENT: 'ROLE_ASSIGNMENT',
  NIGHT_PHASE: 'NIGHT_PHASE',
  DAY_PHASE: 'DAY_PHASE',
  VOTING: 'VOTING',
  RESOLUTION: 'RESOLUTION',
});

const ROLES = Object.freeze({
  NARRATOR: 'الراوي',
  MAFIA: 'المافيا',
  CITIZEN: 'المواطن',
  DETECTIVE: 'المحقق',
  DOCTOR: 'الطبيب',
});

const ALIGNMENT = Object.freeze({
  MAFIA: 'MAFIA',
  CITIZEN: 'CITIZEN',
});

const DEFAULT_ROOM_SETTINGS = Object.freeze({
  mafiaCount: 1,
  doctorCount: 1,
  detectiveCount: 1,
});

const SETTINGS_LIMITS = Object.freeze({
  mafia: { min: 1, max: 6 },
  doctor: { min: 0, max: 4 },
  detective: { min: 0, max: 4 },
});

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const ALLOW_DISCORD_EMBEDDED_ORIGINS = process.env.ALLOW_DISCORD_EMBEDDED_ORIGINS !== 'false';

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesConfiguredOrigin(origin, hostname) {
  for (const allowed of ALLOWED_ORIGINS) {
    const normalizedAllowed = normalizeOrigin(allowed);

    if (!normalizedAllowed) {
      continue;
    }

    if (normalizedAllowed === '*') {
      return true;
    }

    if (origin === normalizedAllowed) {
      return true;
    }

    if (normalizedAllowed.startsWith('*.')) {
      const suffix = normalizedAllowed.slice(2).toLowerCase();
      if (hostname && (hostname === suffix || hostname.endsWith(`.${suffix}`))) {
        return true;
      }
    }
  }

  return false;
}

function isDiscordEmbeddedOrigin(hostname) {
  if (!hostname) {
    return false;
  }

  if (hostname === 'discord.com' || hostname === 'ptb.discord.com' || hostname === 'canary.discord.com') {
    return true;
  }

  return hostname.endsWith('.discordsays.com');
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const hostname = hostnameFromOrigin(normalizedOrigin);

  if (ALLOWED_ORIGINS.length === 0) {
    return true;
  }

  if (matchesConfiguredOrigin(normalizedOrigin, hostname)) {
    return true;
  }

  if (ALLOW_DISCORD_EMBEDDED_ORIGINS && isDiscordEmbeddedOrigin(hostname)) {
    return true;
  }

  return false;
}

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedCorsOrigin(origin));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
});

const rooms = new Map();

function normalizeRoomId(value) {
  return String(value || '')
    .trim()
    .slice(0, 120);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCount(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.floor(numeric);
}

function sanitizeRoomSettings(input = {}, current = DEFAULT_ROOM_SETTINGS) {
  const mafiaCount = clamp(
    parseCount(input.mafiaCount, current.mafiaCount),
    SETTINGS_LIMITS.mafia.min,
    SETTINGS_LIMITS.mafia.max,
  );

  const doctorCount = clamp(
    parseCount(input.doctorCount, current.doctorCount),
    SETTINGS_LIMITS.doctor.min,
    SETTINGS_LIMITS.doctor.max,
  );

  const detectiveCount = clamp(
    parseCount(input.detectiveCount, current.detectiveCount),
    SETTINGS_LIMITS.detective.min,
    SETTINGS_LIMITS.detective.max,
  );

  return {
    mafiaCount,
    doctorCount,
    detectiveCount,
  };
}

function roomRequirementsFromSettings(settings) {
  const specialRoles = settings.mafiaCount + settings.doctorCount + settings.detectiveCount;
  const minimumCitizens = 1;
  const minimumParticipants = specialRoles + minimumCitizens;
  const minimumPlayers = minimumParticipants + 1; // + الراوي

  return {
    specialRoles,
    minimumCitizens,
    minimumParticipants,
    minimumPlayers,
  };
}

function createNightState() {
  return {
    submittedBy: new Set(),
    mafiaSelections: new Map(),
    doctorSelections: new Map(),
    detectiveSelections: new Map(),
  };
}

function createRoom(roomId) {
  const settings = sanitizeRoomSettings();

  return {
    id: roomId,
    phase: PHASES.LOBBY,
    hostSocketId: null,
    winner: null,
    round: 0,
    players: new Map(),
    votes: new Map(),
    night: createNightState(),
    lastResolution: null,
    settings,
    createdAt: Date.now(),
  };
}

function getOrCreateRoom(roomId) {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }

  const room = createRoom(roomId);
  rooms.set(roomId, room);
  return room;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function alivePlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.isAlive);
}

function alivePlayablePlayers(room) {
  return alivePlayers(room).filter((player) => player.role !== ROLES.NARRATOR);
}

function ensureHost(room) {
  if (room.hostSocketId && room.players.has(room.hostSocketId)) {
    for (const player of room.players.values()) {
      player.isHost = player.socketId === room.hostSocketId;
    }
    return;
  }

  const [nextHost] = room.players.values();
  room.hostSocketId = nextHost ? nextHost.socketId : null;

  for (const player of room.players.values()) {
    player.isHost = player.socketId === room.hostSocketId;
  }

  if (room.phase === PHASES.LOBBY && room.hostSocketId) {
    const host = room.players.get(room.hostSocketId);
    if (host) {
      host.role = ROLES.NARRATOR;
      host.isAlive = true;
    }
  }
}

function rolePoolFromSettings(participantCount, settings) {
  const pool = [];

  for (let i = 0; i < settings.mafiaCount; i += 1) {
    pool.push(ROLES.MAFIA);
  }

  for (let i = 0; i < settings.doctorCount; i += 1) {
    pool.push(ROLES.DOCTOR);
  }

  for (let i = 0; i < settings.detectiveCount; i += 1) {
    pool.push(ROLES.DETECTIVE);
  }

  while (pool.length < participantCount) {
    pool.push(ROLES.CITIZEN);
  }

  return shuffle(pool);
}

function assignRoles(room) {
  const players = Array.from(room.players.values());
  const host = room.hostSocketId ? room.players.get(room.hostSocketId) : null;

  for (const player of players) {
    player.isAlive = true;
    player.isReady = false;
  }

  if (host) {
    host.role = ROLES.NARRATOR;
  }

  const participants = players.filter((player) => player.socketId !== room.hostSocketId);
  const pool = rolePoolFromSettings(participants.length, room.settings);

  participants.forEach((player, index) => {
    player.role = pool[index];
  });
}

function getNightRequiredActors(room) {
  if (room.phase !== PHASES.NIGHT_PHASE) {
    return [];
  }

  return alivePlayers(room)
    .filter((player) => [ROLES.MAFIA, ROLES.DOCTOR, ROLES.DETECTIVE].includes(player.role))
    .map((player) => player.socketId);
}

function chooseTargetFromTallies(targetIds) {
  if (targetIds.length === 0) {
    return null;
  }

  const tally = new Map();
  for (const targetId of targetIds) {
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }

  let max = 0;
  const leaders = [];

  for (const [targetId, votes] of tally.entries()) {
    if (votes > max) {
      max = votes;
      leaders.length = 0;
      leaders.push(targetId);
      continue;
    }

    if (votes === max) {
      leaders.push(targetId);
    }
  }

  if (leaders.length === 1) {
    return leaders[0];
  }

  const randomIndex = Math.floor(Math.random() * leaders.length);
  return leaders[randomIndex];
}

function getVoteTallies(room) {
  const tallies = {};

  for (const targetId of room.votes.values()) {
    tallies[targetId] = (tallies[targetId] || 0) + 1;
  }

  return tallies;
}

function checkWinner(room) {
  const alive = alivePlayablePlayers(room);
  const mafiaAlive = alive.filter((player) => player.role === ROLES.MAFIA).length;
  const citizensAlive = alive.filter((player) => player.role !== ROLES.MAFIA).length;

  if (mafiaAlive === 0) {
    return ALIGNMENT.CITIZEN;
  }

  if (mafiaAlive >= citizensAlive) {
    return ALIGNMENT.MAFIA;
  }

  return null;
}

function validTarget(room, targetId) {
  const target = room.players.get(targetId);
  if (!target) {
    return false;
  }

  if (!target.isAlive) {
    return false;
  }

  if (target.role === ROLES.NARRATOR) {
    return false;
  }

  return true;
}

function resetToLobby(room) {
  room.phase = PHASES.LOBBY;
  room.winner = null;
  room.round = 0;
  room.votes = new Map();
  room.night = createNightState();
  room.lastResolution = null;

  for (const player of room.players.values()) {
    player.role = player.isHost ? ROLES.NARRATOR : null;
    player.isAlive = true;
    player.isReady = false;
  }
}

function startNightPhase(room) {
  room.phase = PHASES.NIGHT_PHASE;
  room.round += 1;
  room.votes = new Map();
  room.night = createNightState();
  room.lastResolution = null;
}

function enterResolution(room, payload) {
  room.phase = PHASES.RESOLUTION;
  room.lastResolution = payload;
}

function serializePlayerForViewer(room, viewer, player) {
  const isSelf = viewer && viewer.socketId === player.socketId;
  const viewerRole = viewer ? viewer.role : null;
  const isNarratorViewer = viewerRole === ROLES.NARRATOR;
  const isMafiaViewer = viewerRole === ROLES.MAFIA;

  const canSeeRole =
    isSelf ||
    isNarratorViewer ||
    (isMafiaViewer && player.role === ROLES.MAFIA) ||
    (room.phase === PHASES.RESOLUTION && room.winner !== null && !player.isAlive);

  return {
    id: player.socketId,
    discordId: player.discordId,
    username: player.username,
    avatar: player.avatar,
    isAlive: player.isAlive,
    isReady: player.isReady,
    isHost: player.isHost,
    role: canSeeRole ? player.role : null,
    roleHint: player.role === ROLES.MAFIA && isMafiaViewer ? ROLES.MAFIA : null,
  };
}

function getNightViewForViewer(room, viewer) {
  const requiredActors = getNightRequiredActors(room);
  const submittedCount = requiredActors.filter((socketId) => room.night.submittedBy.has(socketId)).length;

  let mafiaSelections = null;
  if (viewer && (viewer.role === ROLES.MAFIA || viewer.role === ROLES.NARRATOR)) {
    mafiaSelections = Array.from(room.night.mafiaSelections.entries()).map(([mafiaId, targetId]) => ({
      mafiaId,
      targetId,
    }));
  }

  let selfSelectionTargetId = null;
  if (viewer) {
    if (viewer.role === ROLES.MAFIA) {
      selfSelectionTargetId = room.night.mafiaSelections.get(viewer.socketId) || null;
    } else if (viewer.role === ROLES.DOCTOR) {
      selfSelectionTargetId = room.night.doctorSelections.get(viewer.socketId) || null;
    } else if (viewer.role === ROLES.DETECTIVE) {
      selfSelectionTargetId = room.night.detectiveSelections.get(viewer.socketId) || null;
    }
  }

  return {
    requiredCount: requiredActors.length,
    submittedCount,
    selfSelectionTargetId,
    selfSubmitted: viewer ? room.night.submittedBy.has(viewer.socketId) : false,
    mafiaSelections,
  };
}

function roomSnapshotForViewer(room, viewerSocketId) {
  const viewer = room.players.get(viewerSocketId) || null;
  const requirements = roomRequirementsFromSettings(room.settings);

  const players = Array.from(room.players.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => serializePlayerForViewer(room, viewer, player));

  return {
    roomId: room.id,
    phase: room.phase,
    round: room.round,
    winner: room.winner,
    self: viewer
      ? {
          id: viewer.socketId,
          discordId: viewer.discordId,
          username: viewer.username,
          avatar: viewer.avatar,
          role: viewer.role,
          isAlive: viewer.isAlive,
          isReady: viewer.isReady,
          isHost: viewer.isHost,
        }
      : null,
    players,
    settings: { ...room.settings },
    requirements,
    votes: getVoteTallies(room),
    night: getNightViewForViewer(room, viewer),
    lastResolution: room.lastResolution,
  };
}

function emitRoomState(room) {
  for (const player of room.players.values()) {
    io.to(player.socketId).emit('room_state', roomSnapshotForViewer(room, player.socketId));
  }
}

function isNarratorController(player) {
  return Boolean(player && (player.isHost || player.role === ROLES.NARRATOR));
}

function playerDisplayName(room, playerId) {
  if (!playerId) {
    return null;
  }

  const player = room.players.get(playerId);
  return player ? player.username : null;
}

function buildNightStory(room, payload) {
  const lines = ['حلّ الليل وسكنت الأصوات في المدينة...'];

  if (payload.killedPlayerId) {
    const killedName = playerDisplayName(room, payload.killedPlayerId) || 'لاعب مجهول';
    lines.push(`مع بزوغ الفجر، تم العثور على ${killedName} جثة هامدة.`);
  } else if (payload.savedPlayerId) {
    const savedName = playerDisplayName(room, payload.savedPlayerId) || 'لاعب مجهول';
    lines.push(`حاولت المافيا استهداف ${savedName} لكن الطبيب أنقذه في اللحظة الأخيرة.`);
  } else {
    lines.push('مرّ الليل بلا ضحايا هذه المرة.');
  }

  if (payload.detectiveDidInvestigate) {
    lines.push('المحقق جمع خيطاً جديداً في الظلام.');
  }

  return lines.join(' ');
}

function buildVotingStory(room, payload) {
  if (payload.eliminatedPlayerId) {
    const eliminatedName = playerDisplayName(room, payload.eliminatedPlayerId) || 'لاعب مجهول';
    return `بعد نقاش طويل، قرر أهل المدينة إقصاء ${eliminatedName}.`;
  }

  return 'انقسمت الأصوات ولم يتم إقصاء أي لاعب بسبب التعادل.';
}

function resolveNight(room, options = {}) {
  const mafiaTargetIds = Array.from(room.night.mafiaSelections.values()).filter((targetId) => validTarget(room, targetId));
  const chosenKillTarget = chooseTargetFromTallies(mafiaTargetIds);

  const healTargets = new Set(
    Array.from(room.night.doctorSelections.values()).filter((targetId) => validTarget(room, targetId)),
  );

  const killedPlayerId = chosenKillTarget && !healTargets.has(chosenKillTarget) ? chosenKillTarget : null;
  const savedPlayerId = chosenKillTarget && healTargets.has(chosenKillTarget) ? chosenKillTarget : null;

  if (killedPlayerId) {
    const killed = room.players.get(killedPlayerId);
    if (killed) {
      killed.isAlive = false;
    }
  }

  const detectiveDidInvestigate = room.night.detectiveSelections.size > 0;

  const winner = checkWinner(room);
  room.winner = winner;

  const resolution = {
    type: 'NIGHT_RESULT',
    round: room.round,
    killedPlayerId,
    savedPlayerId,
    detectiveDidInvestigate,
    forced: Boolean(options.forced),
    winner,
  };
  resolution.story = buildNightStory(room, resolution);

  if (winner) {
    enterResolution(room, resolution);
  } else {
    room.phase = PHASES.DAY_PHASE;
    room.lastResolution = resolution;
    room.votes = new Map();
  }

  emitRoomState(room);
}

function maybeResolveNight(room) {
  if (room.phase !== PHASES.NIGHT_PHASE) {
    return;
  }

  const requiredActors = getNightRequiredActors(room);

  if (requiredActors.length === 0) {
    resolveNight(room);
    return;
  }

  const allSubmitted = requiredActors.every((socketId) => room.night.submittedBy.has(socketId));
  if (allSubmitted) {
    resolveNight(room);
  }
}

function resolveVoting(room, options = {}) {
  const tallies = getVoteTallies(room);
  const entries = Object.entries(tallies);

  let eliminatedPlayerId = null;
  let tiedPlayerIds = [];

  if (entries.length > 0) {
    const maxVotes = Math.max(...entries.map(([, value]) => value));
    tiedPlayerIds = entries.filter(([, value]) => value === maxVotes).map(([playerId]) => playerId);

    if (tiedPlayerIds.length === 1) {
      eliminatedPlayerId = tiedPlayerIds[0];
      const eliminated = room.players.get(eliminatedPlayerId);
      if (eliminated) {
        eliminated.isAlive = false;
      }
    }
  }

  const winner = checkWinner(room);
  room.winner = winner;

  const resolution = {
    type: 'VOTE_RESULT',
    round: room.round,
    tallies,
    eliminatedPlayerId,
    tiedPlayerIds,
    forced: Boolean(options.forced),
    winner,
  };
  resolution.story = buildVotingStory(room, resolution);

  enterResolution(room, resolution);

  emitRoomState(room);
}

function maybeResolveVoting(room) {
  if (room.phase !== PHASES.VOTING) {
    return;
  }

  const eligibleVoters = alivePlayablePlayers(room).map((player) => player.socketId);
  if (eligibleVoters.length === 0) {
    resolveVoting(room);
    return;
  }

  const allVoted = eligibleVoters.every((socketId) => room.votes.has(socketId));
  if (allVoted) {
    resolveVoting(room);
  }
}

function canStartGame(room) {
  const requirements = roomRequirementsFromSettings(room.settings);
  const totalPlayers = room.players.size;
  if (totalPlayers < requirements.minimumPlayers) {
    return {
      ok: false,
      reason: `الحد الأدنى الحالي هو ${requirements.minimumPlayers} لاعبين وفق إعدادات الأدوار.`,
    };
  }

  const participants = Array.from(room.players.values()).filter((player) => player.socketId !== room.hostSocketId);
  if (participants.length < requirements.minimumParticipants) {
    return {
      ok: false,
      reason: `تحتاج إلى ${requirements.minimumParticipants} مشاركين على الأقل (بدون الراوي).`,
    };
  }

  const unready = participants.some((player) => !player.isReady);
  if (unready) {
    return {
      ok: false,
      reason: 'يجب أن يعلن جميع اللاعبين الجاهزية قبل البدء.',
    };
  }

  return { ok: true };
}

function emitError(socket, message) {
  socket.emit('game_error', { message });
}

function skipCurrentPhase(room) {
  if (room.phase === PHASES.LOBBY) {
    return {
      ok: false,
      message: 'لا يمكن التخطي في اللوبي قبل بدء اللعبة.',
    };
  }

  if (room.phase === PHASES.ROLE_ASSIGNMENT) {
    startNightPhase(room);
    emitRoomState(room);
    maybeResolveNight(room);
    return {
      ok: true,
      message: 'تم تخطي توزيع الأدوار والانتقال مباشرة إلى الليل.',
    };
  }

  if (room.phase === PHASES.NIGHT_PHASE) {
    resolveNight(room, { forced: true });
    return {
      ok: true,
      message: 'تم إنهاء الليل يدوياً بواسطة الراوي.',
    };
  }

  if (room.phase === PHASES.DAY_PHASE) {
    room.phase = PHASES.VOTING;
    room.votes = new Map();
    emitRoomState(room);
    maybeResolveVoting(room);
    return {
      ok: true,
      message: 'تم تخطي النقاش والانتقال مباشرة إلى التصويت.',
    };
  }

  if (room.phase === PHASES.VOTING) {
    resolveVoting(room, { forced: true });
    return {
      ok: true,
      message: 'تم إنهاء التصويت فوراً بواسطة الراوي.',
    };
  }

  if (room.phase === PHASES.RESOLUTION) {
    if (room.winner) {
      resetToLobby(room);
      emitRoomState(room);
      return {
        ok: true,
        message: 'تمت إعادة الغرفة إلى اللوبي بعد إعلان الفائز.',
      };
    }

    startNightPhase(room);
    emitRoomState(room);
    maybeResolveNight(room);
    return {
      ok: true,
      message: 'تم تخطي شاشة النتيجة وبدء ليلة جديدة.',
    };
  }

  return {
    ok: false,
    message: 'لا يمكن التخطي في هذه المرحلة.',
  };
}

function removePlayerFromRoom(room, socketId) {
  const player = room.players.get(socketId);
  if (!player) {
    return;
  }

  room.players.delete(socketId);

  room.night.submittedBy.delete(socketId);
  room.night.mafiaSelections.delete(socketId);
  room.night.doctorSelections.delete(socketId);
  room.night.detectiveSelections.delete(socketId);
  room.votes.delete(socketId);

  for (const [voterId, targetId] of room.votes.entries()) {
    if (targetId === socketId) {
      room.votes.delete(voterId);
    }
  }

  if (room.hostSocketId === socketId) {
    room.hostSocketId = null;
    ensureHost(room);
  }

  if (room.players.size === 0) {
    rooms.delete(room.id);
    return;
  }

  if (room.phase !== PHASES.LOBBY) {
    const winner = checkWinner(room);
    room.winner = winner;
    if (winner && room.phase !== PHASES.RESOLUTION) {
      const departedName = player.username;
      enterResolution(room, {
        type: 'FORFEIT_RESULT',
        round: room.round,
        story: `غادر ${departedName} الغرفة أثناء الجولة، وتم حسم اللعبة تلقائياً.`,
        forced: true,
        winner,
      });
    }

    maybeResolveNight(room);
    maybeResolveVoting(room);
  }

  emitRoomState(room);
}

function defaultAvatarUrl(userId, discriminator) {
  const index = Number(discriminator || 0) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function avatarUrlFromDiscordUser(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }

  return defaultAvatarUrl(user.id, user.discriminator);
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, rooms: rooms.size, now: new Date().toISOString() });
});

app.post('/api/discord/token', async (req, res) => {
  try {
    const { code } = req.body || {};

    if (!code) {
      res.status(400).json({ error: 'Missing OAuth code.' });
      return;
    }

    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      res.status(500).json({
        error:
          'Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET in backend environment variables.',
      });
      return;
    }

    const payload = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    });

    if (DISCORD_REDIRECT_URI) {
      payload.set('redirect_uri', DISCORD_REDIRECT_URI);
    }

    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'DiscordMafiaActivity/1.0',
      },
      body: payload,
    });

    const tokenText = await tokenResponse.text();
    let tokenJson = null;

    try {
      tokenJson = JSON.parse(tokenText);
    } catch {
      res.status(502).json({
        error: 'Discord token endpoint returned non-JSON response.',
        status: tokenResponse.status,
        contentType: tokenResponse.headers.get('content-type'),
        finalUrl: tokenResponse.url,
        bodyPreview: tokenText.slice(0, 500),
      });
      return;
    }

    if (!tokenResponse.ok) {
      res.status(tokenResponse.status).json({
        error: 'Discord OAuth token exchange failed.',
        details: tokenJson,
      });
      return;
    }

    res.status(200).json(tokenJson);
  } catch (error) {
    res.status(500).json({
      error: 'Unexpected token exchange error.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/discord/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : req.query.access_token;

    if (!accessToken) {
      res.status(400).json({ error: 'Missing access token.' });
      return;
    }

    const meResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const meJson = await meResponse.json();

    if (!meResponse.ok) {
      res.status(meResponse.status).json({
        error: 'Failed to fetch Discord profile.',
        details: meJson,
      });
      return;
    }

    res.status(200).json({
      id: meJson.id,
      username: meJson.username,
      displayName: meJson.global_name || meJson.username,
      avatar: avatarUrlFromDiscordUser(meJson),
      raw: meJson,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Unexpected profile fetch error.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).json({
    error: 'Unhandled backend error.',
    details: error instanceof Error ? error.message : String(error),
  });
});

io.on('connection', (socket) => {
  socket.on('join_room', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId);

    if (!roomId) {
      emitError(socket, 'معرّف الغرفة غير صالح.');
      return;
    }

    const profile = payload.profile || {};
    const discordId = String(profile.id || socket.id);
    const username = String(profile.displayName || profile.username || `Player-${discordId.slice(-4)}`);
    const avatar = profile.avatar || null;

    const room = getOrCreateRoom(roomId);
    const existingByDiscord = Array.from(room.players.values()).find(
      (player) => player.discordId === discordId,
    );

    if (existingByDiscord && existingByDiscord.socketId !== socket.id) {
      room.players.delete(existingByDiscord.socketId);
    }

    const player = {
      socketId: socket.id,
      discordId,
      username,
      avatar,
      role: null,
      isAlive: true,
      isReady: false,
      isHost: false,
      joinedAt: Date.now(),
    };

    room.players.set(socket.id, player);

    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
      player.isHost = true;
      player.role = ROLES.NARRATOR;
    } else {
      ensureHost(room);
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    io.to(roomId).emit('system_notice', {
      message: `${username} انضم إلى الغرفة`,
    });

    emitRoomState(room);
  });

  socket.on('set_ready', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.phase !== PHASES.LOBBY) {
      emitError(socket, 'لا يمكن تغيير الجاهزية بعد بدء اللعبة.');
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    player.isReady = Boolean(payload.ready);
    emitRoomState(room);
  });

  socket.on('update_room_settings', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket, 'فقط الراوي يمكنه تعديل إعدادات الغرفة.');
      return;
    }

    if (room.phase !== PHASES.LOBBY) {
      emitError(socket, 'يمكن تعديل الإعدادات فقط داخل اللوبي قبل بدء اللعبة.');
      return;
    }

    const incoming = payload.settings || payload;
    room.settings = sanitizeRoomSettings(incoming, room.settings);
    emitRoomState(room);
  });

  socket.on('start_game', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);

    if (!room) {
      emitError(socket, 'الغرفة غير موجودة.');
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket, 'فقط الراوي يمكنه بدء اللعبة.');
      return;
    }

    if (room.phase !== PHASES.LOBBY) {
      emitError(socket, 'اللعبة بدأت بالفعل.');
      return;
    }

    const gate = canStartGame(room);
    if (!gate.ok) {
      emitError(socket, gate.reason);
      return;
    }

    room.phase = PHASES.ROLE_ASSIGNMENT;
    room.round = 0;
    room.winner = null;
    room.lastResolution = null;
    room.votes = new Map();
    room.night = createNightState();

    assignRoles(room);
    emitRoomState(room);

    setTimeout(() => {
      const liveRoom = rooms.get(roomId);
      if (!liveRoom || liveRoom.phase !== PHASES.ROLE_ASSIGNMENT) {
        return;
      }

      startNightPhase(liveRoom);
      emitRoomState(liveRoom);
      maybeResolveNight(liveRoom);
    }, 2500);
  });

  socket.on('begin_voting', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    if (!(player.isHost || player.role === ROLES.NARRATOR)) {
      emitError(socket, 'فقط الراوي يمكنه فتح التصويت.');
      return;
    }

    if (room.phase !== PHASES.DAY_PHASE) {
      emitError(socket, 'يمكن فتح التصويت فقط خلال مرحلة النهار.');
      return;
    }

    room.phase = PHASES.VOTING;
    room.votes = new Map();
    emitRoomState(room);
    maybeResolveVoting(room);
  });

  socket.on('skip_phase', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!isNarratorController(player)) {
      emitError(socket, 'فقط الراوي يمكنه تخطي المراحل.');
      return;
    }

    const result = skipCurrentPhase(room);
    if (!result.ok) {
      emitError(socket, result.message);
      return;
    }

    io.to(roomId).emit('system_notice', {
      message: result.message,
    });
  });

  socket.on('cast_vote', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const targetId = String(payload.targetId || '');

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.phase !== PHASES.VOTING) {
      emitError(socket, 'التصويت غير متاح حالياً.');
      return;
    }

    const voter = room.players.get(socket.id);
    if (!voter || !voter.isAlive || voter.role === ROLES.NARRATOR) {
      emitError(socket, 'هذا اللاعب غير مخوّل للتصويت.');
      return;
    }

    if (!validTarget(room, targetId)) {
      emitError(socket, 'هدف التصويت غير صالح.');
      return;
    }

    room.votes.set(socket.id, targetId);
    emitRoomState(room);
    maybeResolveVoting(room);
  });

  socket.on('next_round', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    if (!(player.isHost || player.role === ROLES.NARRATOR)) {
      emitError(socket, 'فقط الراوي يمكنه تحريك الجولة التالية.');
      return;
    }

    if (room.phase !== PHASES.RESOLUTION) {
      emitError(socket, 'الجولة التالية متاحة فقط بعد إعلان النتيجة.');
      return;
    }

    if (room.winner) {
      emitError(socket, 'انتهت اللعبة بالفعل. استخدم إعادة التشغيل.');
      return;
    }

    startNightPhase(room);
    emitRoomState(room);
    maybeResolveNight(room);
  });

  socket.on('restart_game', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    if (socket.id !== room.hostSocketId) {
      emitError(socket, 'فقط الراوي يمكنه إعادة اللعبة.');
      return;
    }

    resetToLobby(room);
    emitRoomState(room);
  });

  socket.on('kill_target', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const targetId = String(payload.targetId || '');
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    if (room.phase !== PHASES.NIGHT_PHASE) {
      emitError(socket, 'هجوم المافيا متاح فقط ليلاً.');
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.isAlive || player.role !== ROLES.MAFIA) {
      emitError(socket, 'هذا اللاعب ليس من المافيا الفعّالة.');
      return;
    }

    if (!validTarget(room, targetId)) {
      emitError(socket, 'هدف القتل غير صالح.');
      return;
    }

    if (targetId === socket.id) {
      emitError(socket, 'لا يمكن لعضو المافيا استهداف نفسه.');
      return;
    }

    room.night.mafiaSelections.set(socket.id, targetId);
    room.night.submittedBy.add(socket.id);

    emitRoomState(room);
    maybeResolveNight(room);
  });

  socket.on('heal_target', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const targetId = String(payload.targetId || '');
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    if (room.phase !== PHASES.NIGHT_PHASE) {
      emitError(socket, 'اختيار الطبيب متاح فقط ليلاً.');
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.isAlive || player.role !== ROLES.DOCTOR) {
      emitError(socket, 'هذا اللاعب ليس طبيباً فعّالاً.');
      return;
    }

    if (!validTarget(room, targetId)) {
      emitError(socket, 'هدف العلاج غير صالح.');
      return;
    }

    room.night.doctorSelections.set(socket.id, targetId);
    room.night.submittedBy.add(socket.id);

    emitRoomState(room);
    maybeResolveNight(room);
  });

  socket.on('investigate_target', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || socket.data.roomId);
    const targetId = String(payload.targetId || '');
    const room = rooms.get(roomId);

    if (!room) {
      return;
    }

    if (room.phase !== PHASES.NIGHT_PHASE) {
      emitError(socket, 'تحقيق المحقق متاح فقط ليلاً.');
      return;
    }

    const player = room.players.get(socket.id);
    if (!player || !player.isAlive || player.role !== ROLES.DETECTIVE) {
      emitError(socket, 'هذا اللاعب ليس محققاً فعّالاً.');
      return;
    }

    if (!validTarget(room, targetId)) {
      emitError(socket, 'هدف التحقيق غير صالح.');
      return;
    }

    if (targetId === socket.id) {
      emitError(socket, 'لا يمكن للمحقق التحقيق مع نفسه.');
      return;
    }

    const target = room.players.get(targetId);
    const alignment = target && target.role === ROLES.MAFIA ? ALIGNMENT.MAFIA : ALIGNMENT.CITIZEN;

    room.night.detectiveSelections.set(socket.id, targetId);
    room.night.submittedBy.add(socket.id);

    socket.emit('detective_result', {
      targetId,
      targetName: target ? target.username : 'Unknown',
      alignment,
    });

    emitRoomState(room);
    maybeResolveNight(room);
  });

  socket.on('disconnect', () => {
    const roomId = normalizeRoomId(socket.data.roomId);
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (player) {
      io.to(roomId).emit('system_notice', {
        message: `${player.username} غادر الغرفة`,
      });
    }

    removePlayerFromRoom(room, socket.id);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mafia backend is running on port ${PORT}`);
});
