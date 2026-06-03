import state from './state.js';
import { loadEventCatalog } from './eventCatalog.js';
import { once } from './utils.js';

export function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function getSpeakersInfo(speakers) {
  if (!speakers) {
    return { text: '', isMultiple: false };
  }

  if (Array.isArray(speakers)) {
    const cleaned = speakers.map((speaker) => String(speaker || '').trim()).filter(Boolean);
    return {
      text: cleaned.join(', '),
      isMultiple: cleaned.length > 1
    };
  }

  const text = String(speakers).trim();
  if (!text) {
    return { text: '', isMultiple: false };
  }

  return {
    text,
    isMultiple: text.includes(',')
  };
}

export function parseSpeakerUsername(rawName) {
  const text = String(rawName || '').trim();
  if (!text) return '';
  const bracketMatch = text.match(/\(([^)]+)\)\s*$/);
  if (bracketMatch && !/\s/.test(bracketMatch[1])) {
    return bracketMatch[1].replace(/^@/, '').trim();
  }
  if (/^@?[a-z0-9._-]+$/i.test(text) && !/\s/.test(text)) {
    return text.replace(/^@/, '').trim();
  }
  return '';
}

export function isUsernameLike(value) {
  const token = normalizeText(value);
  return /^[a-z0-9_.-]{2,}$/i.test(token) && !/\s/.test(token);
}

export function parseSpeakerIdentity(value) {
  const parseBracketed = (inputName, inputUsername = '') => {
    const candidateName = normalizeText(inputName);
    const explicitUsername = normalizeText(inputUsername);
    if (!candidateName && !explicitUsername) return null;

    if (explicitUsername) {
      return {
        name: candidateName || explicitUsername,
        username: explicitUsername
      };
    }

    const bracketed = candidateName.match(/^(.+?)\s*\(([^()]{2,})\)\s*$/);
    if (bracketed) {
      const namePart = normalizeText(bracketed[1]);
      const usernamePart = normalizeText(bracketed[2]);
      if (isUsernameLike(usernamePart)) {
        return {
          name: namePart || usernamePart,
          username: usernamePart
        };
      }
    }

    if (isUsernameLike(candidateName)) {
      return { name: candidateName, username: candidateName };
    }

    return { name: candidateName, username: '' };
  };

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectName = normalizeText(value.name);
    const objectUsername = normalizeText(value.username);
    if (objectName || objectUsername) {
      return parseBracketed(objectName, objectUsername);
    }
  }

  const raw = normalizeText(value);
  if (!raw) return null;
  return parseBracketed(raw, '');
}

export function isIgnoredSpeakerIdentity(identity) {
  const name = normalizeText(identity?.name).toLowerCase();
  if (!name) return true;
  return ['tba', 'event team', 'speaker tbc', 'to be announced', 'drupal association'].includes(name);
}

export function speakerKeys(speaker) {
  const identity = parseSpeakerIdentity(speaker);
  if (!identity || isIgnoredSpeakerIdentity(identity)) return [];
  const keys = [];
  if (identity.username) keys.push(`u:${identity.username.toLowerCase()}`);
  if (identity.name) keys.push(`n:${identity.name.toLowerCase()}`);
  return [...new Set(keys)];
}

export function getSpeakerEntries(event) {
  const rawSpeakers = Array.isArray(event?.speakers)
    ? event.speakers
    : typeof event?.speakers === 'string'
      ? event.speakers
        .split(/\s*,\s*|\s+\/\s+/g)
        .map((part) => String(part || '').trim())
        .filter(Boolean)
      : [];
  if (!Array.isArray(rawSpeakers) || rawSpeakers.length === 0) return [];
  const usernames = Array.isArray(event.speaker_usernames) ? event.speaker_usernames : [];
  return rawSpeakers
    .map((speaker, index) => {
      const name = String(speaker || '').trim();
      if (!name) return null;
      const inferredUsername = parseSpeakerUsername(name);
      const username = String(usernames[index] || inferredUsername || '').replace(/^@/, '').trim();
      return {
        name,
        username
      };
    })
    .filter(Boolean);
}

export function truncateText(text, limit = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}...`;
}

export function formatTalkWhen(talk) {
  if (!talk?.startTime) return '';
  const startDate = new Date(talk.startTime);
  const endDate = new Date(talk.endTime || talk.startTime);
  const timezone = talk.timezone || state.eventMeta?.timezone;
  const day = startDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone
  });
  const startTime = startDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone
  });
  const endTime = endDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone
  });
  return `${day}, ${startTime} - ${endTime}`;
}

export function getTalkLocalDateKey(talk) {
  if (!talk?.startTime) return '';
  const timezone = talk.timezone || state.eventMeta?.timezone;
  return new Date(talk.startTime).toLocaleDateString('en-CA', { timeZone: timezone });
}

export function talkSignature(talk) {
  return `${talk.file || ''}|${talk.startTime || ''}|${talk.location || ''}|${talk.title || ''}`;
}

export function collapseSpeakerModalTalks(talks) {
  const map = new Map();
  talks.forEach((talk) => {
    const key = `${talk.file || ''}|${getTalkLocalDateKey(talk)}|${normalizeText(talk.title).toLowerCase()}`;
    const signature = talkSignature(talk);
    if (!map.has(key)) {
      map.set(key, {
        ...talk,
        __sourceSignatures: [signature],
        __occurrenceCount: 1
      });
      return;
    }
    const existing = map.get(key);
    existing.__sourceSignatures.push(signature);
    existing.__occurrenceCount += 1;

    const existingStart = Date.parse(existing.startTime || '');
    const candidateStart = Date.parse(talk.startTime || '');
    if (!Number.isNaN(candidateStart) && (Number.isNaN(existingStart) || candidateStart < existingStart)) {
      existing.startTime = talk.startTime;
      existing.location = talk.location;
    }

    const existingEnd = Date.parse(existing.endTime || '');
    const candidateEnd = Date.parse(talk.endTime || '');
    if (!Number.isNaN(candidateEnd) && (Number.isNaN(existingEnd) || candidateEnd > existingEnd)) {
      existing.endTime = talk.endTime;
    }

    // Prefer richer metadata when collapsing repeated slots.
    if (!existing.link && talk.link) existing.link = talk.link;
    if (!existing.video_url && talk.video_url) existing.video_url = talk.video_url;
    if ((String(talk.full_description || '').length || 0) > (String(existing.full_description || '').length || 0)) {
      existing.full_description = talk.full_description;
    }
  });
  return [...map.values()];
}

export function getSpeakerListFromTalk(talk) {
  if (!Array.isArray(talk?.speakers)) return [];
  return talk.speakers
    .flatMap((speaker) => {
      const text = normalizeText(speaker);
      if (!text) return [];
      return text
        .split(/\s*,\s*|\s+\/\s+/g)
        .map((part) => normalizeText(part))
        .filter(Boolean);
    });
}

export function getSpeakerUsernamesFromTalk(talk) {
  if (!Array.isArray(talk?.speaker_usernames)) return [];
  return talk.speaker_usernames.map((username) => normalizeText(username)).filter(Boolean);
}

export function buildSpeakerIdentities(speakers, usernames) {
  const identities = [];
  const normalizeToken = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nameTokens = (name) =>
    normalizeText(name)
      .split(/\s+/)
      .map((part) => normalizeToken(part))
      .filter((part) => part.length >= 2);
  const likelyNameMatchesUsername = (name, username) => {
    const uname = normalizeToken(username);
    if (!uname) return false;
    const tokens = nameTokens(name);
    if (tokens.length === 0) return false;
    return tokens.some((token) => uname.startsWith(token) || token.startsWith(uname) || uname.includes(token));
  };
  const addIdentity = (name, username) => {
    const parsed = parseSpeakerIdentity({ name, username });
    if (!parsed || isIgnoredSpeakerIdentity(parsed)) return;

    if (parsed.username && parsed.name.toLowerCase() === parsed.username.toLowerCase()) {
      const matchedByName = identities.find(
        (identity) => !identity.username && likelyNameMatchesUsername(identity.name, parsed.username)
      );
      if (matchedByName) {
        matchedByName.username = parsed.username;
        return;
      }
    }

    const canonical = parsed.username ? `u:${parsed.username.toLowerCase()}` : `n:${parsed.name.toLowerCase()}`;
    if (!canonical) return;
    const existing = identities.find((identity) => {
      const key = identity.username ? `u:${identity.username.toLowerCase()}` : `n:${identity.name.toLowerCase()}`;
      return key === canonical;
    });
    if (existing) {
      if (!existing.username && parsed.username) existing.username = parsed.username;
      if (
        parsed.name &&
        existing.username &&
        existing.name.toLowerCase() === existing.username.toLowerCase() &&
        parsed.name.toLowerCase() !== existing.username.toLowerCase()
      ) {
        existing.name = parsed.name;
      }
      return;
    }
    identities.push(parsed);
  };

  if (speakers.length === 1 && usernames.length >= 1) {
    addIdentity(speakers[0], usernames[0]);
    return identities;
  }

  speakers.forEach((name) => addIdentity(name, ''));
  const assignedSpeakers = new Set();
  usernames.forEach((username) => {
    const candidates = speakers.filter((name) => !assignedSpeakers.has(name) && likelyNameMatchesUsername(name, username));
    if (candidates.length === 1) {
      addIdentity(candidates[0], username);
      assignedSpeakers.add(candidates[0]);
      return;
    }
    if (speakers.length === 0) {
      addIdentity(username, username);
    }
  });
  return identities;
}

export function addTalkForSpeakerKey(index, identity, talk) {
  const keys = speakerKeys(identity);
  keys.forEach((key) => {
    if (!index.talksBySpeakerKey.has(key)) {
      index.talksBySpeakerKey.set(key, []);
    }
    index.talksBySpeakerKey.get(key).push(talk);
  });
}

export function addUserForSpeakerKey(index, input) {
  const identity = parseSpeakerIdentity(input);
  if (!identity || isIgnoredSpeakerIdentity(identity)) return;
  const username = normalizeText(identity.username);
  const name = normalizeText(identity.name);
  const usernameKey = username ? `u:${username.toLowerCase()}` : '';
  const nameKey = name ? `n:${name.toLowerCase()}` : '';
  const usernameAliasNameKey = username ? `n:${username.toLowerCase()}` : '';
  const nameLooksLikeUsername = name && isUsernameLike(name);
  const nameAsUsernameKey = nameLooksLikeUsername ? `u:${name.toLowerCase()}` : '';
  if (!usernameKey && !nameKey) return;

  const existing =
    (usernameKey ? index.usersByKey.get(usernameKey) : null) ||
    (usernameAliasNameKey ? index.usersByKey.get(usernameAliasNameKey) : null) ||
    (nameAsUsernameKey ? index.usersByKey.get(nameAsUsernameKey) : null) ||
    (nameKey ? index.usersByKey.get(nameKey) : null);

  if (existing) {
    if (!Array.isArray(existing.aliases)) {
      existing.aliases = [];
    }
    if (name) {
      const hasAlias = existing.aliases.some((alias) => normalizeText(alias).toLowerCase() === name.toLowerCase());
      if (!hasAlias) existing.aliases.push(name);
    }
    const existingName = normalizeText(existing.name);
    const existingUsername = normalizeText(existing.username);
    const hasBetterDisplayName =
      Boolean(name) &&
      (!existingName ||
        (existingUsername &&
          existingName.toLowerCase() === existingUsername.toLowerCase() &&
          name.toLowerCase() !== existingUsername.toLowerCase()));
    if (hasBetterDisplayName) {
      existing.name = name;
    }
    if (!existing.username && username) existing.username = username;
    if (!existing.username && nameLooksLikeUsername) existing.username = name;
    if (usernameKey) index.usersByKey.set(usernameKey, existing);
    if (nameKey) index.usersByKey.set(nameKey, existing);
    if (usernameAliasNameKey) index.usersByKey.set(usernameAliasNameKey, existing);
    if (nameAsUsernameKey) index.usersByKey.set(nameAsUsernameKey, existing);
    return;
  }

  const created = {
    username: username || (nameLooksLikeUsername ? name : ''),
    name: name || username,
    aliases: name ? [name] : []
  };
  if (usernameKey) index.usersByKey.set(usernameKey, created);
  if (nameKey) index.usersByKey.set(nameKey, created);
  if (usernameAliasNameKey) index.usersByKey.set(usernameAliasNameKey, created);
  if (nameAsUsernameKey) index.usersByKey.set(nameAsUsernameKey, created);
}

export function resolveUserForSpeaker(index, input) {
  const identity = parseSpeakerIdentity(input);
  if (!identity || isIgnoredSpeakerIdentity(identity)) return null;
  const username = normalizeText(identity.username).toLowerCase();
  const name = normalizeText(identity.name).toLowerCase();
  const usernameKey = username ? `u:${username}` : '';
  const nameKey = name ? `n:${name}` : '';
  const usernameAliasNameKey = username ? `n:${username}` : '';
  const nameLooksLikeUsername = name && isUsernameLike(name);
  const nameAsUsernameKey = nameLooksLikeUsername ? `u:${name}` : '';
  return (
    (usernameKey ? index.usersByKey.get(usernameKey) : null) ||
    (nameKey ? index.usersByKey.get(nameKey) : null) ||
    (usernameAliasNameKey ? index.usersByKey.get(usernameAliasNameKey) : null) ||
    (nameAsUsernameKey ? index.usersByKey.get(nameAsUsernameKey) : null) ||
    null
  );
}

export function getTalksForUserFromIndex(index, user) {
  const keys = [];
  const username = normalizeText(user?.username).toLowerCase();
  const name = normalizeText(user?.name).toLowerCase();
  if (username) keys.push(`u:${username}`);
  if (name) keys.push(`n:${name}`);

  const map = new Map();
  keys.forEach((key) => {
    const talks = index.talksBySpeakerKey.get(key) || [];
    talks.forEach((talk) => {
      const dedupeKey = `${talk.file}|${talk.startTime}|${talk.title}`;
      map.set(dedupeKey, talk);
    });
  });

  return [...map.values()].sort((a, b) => {
    const at = new Date(a.startTime || '').getTime();
    const bt = new Date(b.startTime || '').getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return (a.title || '').localeCompare(b.title || '');
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

export const loadAllTalks = once(async () => {
  const catalog = await loadEventCatalog();
  const files = [...new Set(catalog.map((item) => item.file).filter(Boolean))];
  const talks = [];
  const speakerIndex = {
    usersByKey: new Map(),
    talksBySpeakerKey: new Map()
  };

  await Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetch(`./data/${file}`);
        if (!response.ok) return;
        const payload = await response.json();
        const meta = payload?.event || {};
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const eventLabel = [meta.designation, meta.year, meta.location].filter(Boolean).join(' ');
        items.forEach((item) => {
          const talk = {
            ...item,
            file,
            eventLabel,
            timezone: meta.timezone || '',
            uid: `${file}::${item.startTime || ''}::${item.location || ''}::${item.title || ''}`
          };
          talks.push(talk);

          const speakers = getSpeakerListFromTalk(talk);
          const speakerUsernames = getSpeakerUsernamesFromTalk(talk);
          const speakerIdentities = buildSpeakerIdentities(speakers, speakerUsernames);
          if (speakerIdentities.length === 0) return;
          speakerIdentities.forEach((identity) => {
            addTalkForSpeakerKey(speakerIndex, identity, talk);
            addUserForSpeakerKey(speakerIndex, identity);
          });
        });
      } catch {
        // Continue when one dataset file cannot be read.
      }
    })
  );

  return { talks, speakerIndex };
});
