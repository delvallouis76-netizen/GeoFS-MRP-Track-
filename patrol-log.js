'use strict';
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         MRP COMMAND — Patrol Log Module                 ║
 * ║  Add this file alongside mrp-track-bot.js              ║
 * ║  Tracks registered pilots online/offline via GeoFS API ║
 * ║  Logs completed flights with base detection            ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * ADDS THESE COMMANDS:
 *   /pilot add callsign acid       — register a pilot to track
 *   /pilot remove callsign         — stop tracking
 *   /pilot list                    — show all registered pilots
 *   /pilot status callsign         — check one pilot right now
 *   /patrolconfig status_channel   — set online/offline channel
 *   /patrolconfig log_channel      — set flight log channel
 *
 * REQUIRES in your main bot file:
 *   const PatrolLog = require('./patrol-log');
 *   PatrolLog.init(client, DATA_DIR);
 *   — then in interactionCreate: PatrolLog.handleInteraction(interaction)
 *   — add PatrolLog.CMDS to your slash command registration array
 */

const fs   = require('fs');
const path = require('path');
const { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const GEOFS_API    = process.env.GEOFS_API || 'https://mps.geo-fs.com/map';
const POLL_MS      = 15_000;   // check pilots every 15s
const BASE_RADIUS_NM = 10;     // within 10NM = at that base
const COL = {
  ONLINE:  0x0077CC,
  OFFLINE: 0x1C3A5E,
  LOG:     0x003366,
  ADD:     0x00509E,
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let _client   = null;
let _dataDir  = './data';

// Live session tracking (in-memory only, resets on restart)
// sessions: `guildId:callsign` → { startTs, startBase, lastLat, lastLon, lastBase, lastAlt }
const sessions = new Map();

// ── BASE DATABASE ─────────────────────────────────────────────────────────────
let BASES = []; // loaded once from CSV

function loadBases() {
  const csvPath = path.join(__dirname, 'gmrp-valid-bases.csv');
  try {
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
    const headers = lines[0].split(',');
    const iIcao = headers.indexOf('icao');
    const iName = headers.indexOf('name');
    const iCountry = headers.indexOf('country');
    const iLat  = headers.indexOf('lat');
    const iLon  = headers.indexOf('lon');
    const iService = headers.indexOf('service');

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 6) continue;
      const lat = parseFloat(cols[iLat]);
      const lon = parseFloat(cols[iLon]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      BASES.push({
        icao:    cols[iIcao]?.trim() || '????',
        name:    cols[iName]?.trim() || 'Unknown',
        country: cols[iCountry]?.trim() || '',
        service: cols[iService]?.trim() || '',
        lat, lon,
      });
    }
    console.log(`[PatrolLog] ${BASES.length} bases loaded from CSV.`);
  } catch (e) {
    console.warn('[PatrolLog] gmrp-valid-bases.csv not found:', e.message);
  }
}

// ── MATH ─────────────────────────────────────────────────────────────────────
function distNM(a, b, c, d) {
  const R = 3440.065;
  const dl = (c - a) * Math.PI / 180;
  const dn = (d - b) * Math.PI / 180;
  const x = Math.sin(dl/2)**2 + Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dn/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// Find nearest base within radius — returns base or null
// Only checks bases in watched territories if provided
function nearestBase(lat, lon, territories) {
  let best = null, bestD = BASE_RADIUS_NM;
  for (const b of BASES) {
    // filter by territory if set
    if (territories && territories.length) {
      const match = territories.some(t =>
        b.country.toLowerCase().includes(t.toLowerCase()) ||
        t.toLowerCase().includes(b.country.toLowerCase())
      );
      if (!match) continue;
    }
    const d = distNM(lat, lon, b.lat, b.lon);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

function fmtDuration(ms) {
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}
function nowZ() { return new Date().toISOString().replace('T',' ').slice(0,19) + ' Z'; }
function fmtTs(ms) { return ms ? `<t:${Math.floor(ms/1000)}:T>` : '---'; }

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
function pilotDbPath(gid) { return path.join(_dataDir, `pilots_${gid}.json`); }
function patrolCfgPath(gid) { return path.join(_dataDir, `patrolcfg_${gid}.json`); }

function loadPilots(gid) {
  try { return JSON.parse(fs.readFileSync(pilotDbPath(gid), 'utf8')); }
  catch { return {}; } // { callsign: { callsign, acid, addedBy, addedTs } }
}
function savePilots(gid, data) {
  fs.mkdirSync(_dataDir, { recursive: true });
  fs.writeFileSync(pilotDbPath(gid), JSON.stringify(data, null, 2) + '\n');
}
function loadPatrolCfg(gid) {
  try { return JSON.parse(fs.readFileSync(patrolCfgPath(gid), 'utf8')); }
  catch { return { statusChannel: null, logChannel: null }; }
}
function savePatrolCfg(gid, cfg) {
  fs.mkdirSync(_dataDir, { recursive: true });
  fs.writeFileSync(patrolCfgPath(gid), JSON.stringify(cfg, null, 2) + '\n');
}

// Load all guild IDs that have pilot registrations
function allGuildIds() {
  try {
    if (!fs.existsSync(_dataDir)) return [];
    return fs.readdirSync(_dataDir)
      .filter(f => f.startsWith('pilots_') && f.endsWith('.json'))
      .map(f => f.replace('pilots_', '').replace('.json', ''));
  } catch { return []; }
}

// ── GEOFS FETCH ───────────────────────────────────────────────────────────────
let _cachedPilots = [];
let _lastFetch    = 0;

async function fetchOnlinePilots() {
  // Cache for 10s to avoid hammering the API
  if (Date.now() - _lastFetch < 10_000) return _cachedPilots;
  try {
    const r = await fetch(GEOFS_API, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return _cachedPilots;
    const d = await r.json();
    const users = Array.isArray(d.users) ? d.users : Array.isArray(d) ? d : [];
    _cachedPilots = users.map(u => {
      if (!u || !Array.isArray(u.co) || u.co.length < 2) return null;
      const [lat, lon, altM = 0, hdg = 0] = u.co;
      if (!isFinite(lat) || !isFinite(lon)) return null;
      const cs = String(u.cs || u.callsign || '').trim();
      if (!cs) return null;
      return {
        cs,
        acid: String(u.id || u.acid || ''),
        lat, lon,
        alt: altM * 3.28084,
        hdg,
        spd: u.st?.as ?? u.st?.gs ?? null,
      };
    }).filter(Boolean);
    _lastFetch = Date.now();
    return _cachedPilots;
  } catch (e) {
    console.warn('[PatrolLog] GeoFS fetch:', e.message);
    return _cachedPilots;
  }
}

// Find a registered pilot in online list
// Match by exact callsign (case-insensitive)
// If ACID provided, also try acid match
function findOnline(pilots, callsign, acid) {
  const csUp = callsign.toUpperCase();
  return pilots.find(p => {
    if (p.cs.toUpperCase() === csUp) return true;
    if (acid && p.acid && p.acid === acid) return true;
    return false;
  }) || null;
}

// ── MONITORING LOOP ───────────────────────────────────────────────────────────
async function monitorPilots() {
  const guildIds = allGuildIds();
  if (!guildIds.length) return;

  const online = await fetchOnlinePilots();

  for (const gid of guildIds) {
    const pilots    = loadPilots(gid);
    const cfg       = loadPatrolCfg(gid);
    const territories = loadTerritories(gid); // reads from main bot config

    for (const [cs, pilot] of Object.entries(pilots)) {
      const contact = findOnline(online, pilot.callsign, pilot.acid);
      const sessionKey = `${gid}:${cs}`;
      const existing = sessions.get(sessionKey);

      if (contact) {
        // PILOT IS ONLINE
        const base = nearestBase(contact.lat, contact.lon, territories);

        if (!existing) {
          // Just came online
          sessions.set(sessionKey, {
            startTs:   Date.now(),
            startBase: base,
            lastLat:   contact.lat,
            lastLon:   contact.lon,
            lastAlt:   contact.alt,
            lastBase:  base,
            lastSpd:   contact.spd,
          });
          await sendStatusMsg(gid, cfg, pilot, contact, base, true);
        } else {
          // Update session
          existing.lastLat  = contact.lat;
          existing.lastLon  = contact.lon;
          existing.lastAlt  = contact.alt;
          existing.lastBase = base;
          existing.lastSpd  = contact.spd;
        }
      } else {
        // PILOT IS OFFLINE
        if (existing) {
          // Just went offline — log the flight
          await sendStatusMsg(gid, cfg, pilot, null, existing.lastBase, false);
          await sendFlightLog(gid, cfg, pilot, existing, territories);
          sessions.delete(sessionKey);
        }
      }
    }
  }
}

// Load territories from main bot config
function loadTerritories(gid) {
  try {
    const cfgPath = path.join(_dataDir, `${gid}.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.territories || [];
  } catch { return []; }
}

// ── DISCORD MESSAGES ──────────────────────────────────────────────────────────
async function sendStatusMsg(gid, cfg, pilot, contact, base, isOnline) {
  if (!cfg.statusChannel || !_client) return;
  try {
    const ch = await _client.channels.fetch(cfg.statusChannel).catch(() => null);
    if (!ch?.isTextBased()) return;

    const baseStr = base ? `${base.icao} — ${base.name}` : 'Unknown location';
    const e = new EmbedBuilder()
      .setColor(isOnline ? COL.ONLINE : COL.OFFLINE)
      .setTitle(isOnline
        ? `🟢 PILOT ONLINE — ${pilot.callsign}`
        : `🔴 PILOT OFFLINE — ${pilot.callsign}`)
      .addFields(
        { name: 'Callsign', value: `\`${pilot.callsign}\``, inline: true },
        { name: 'Status',   value: isOnline ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
        { name: isOnline ? 'Location' : 'Last Location',
          value: baseStr, inline: true },
        ...(isOnline && contact ? [
          { name: 'Altitude', value: `${Math.round(contact.alt)}ft`, inline: true },
          { name: 'Speed',    value: contact.spd != null ? `${Math.round(contact.spd)}kt` : '---', inline: true },
        ] : []),
      )
      .setFooter({ text: `MRP COMMAND · Patrol Log · ${nowZ()}` })
      .setTimestamp();

    await ch.send({ embeds: [e] });
  } catch (e) {
    console.error('[PatrolLog] Status msg error:', e.message);
  }
}

async function sendFlightLog(gid, cfg, pilot, session, territories) {
  if (!cfg.logChannel || !_client) return;
  try {
    const ch = await _client.channels.fetch(cfg.logChannel).catch(() => null);
    if (!ch?.isTextBased()) return;

    const duration = Date.now() - session.startTs;
    const startBase = session.startBase;
    const endBase   = session.lastBase;

    // Build location notes
    const locationNotes = buildLocationNotes(startBase, endBase, territories);

    const e = new EmbedBuilder()
      .setColor(COL.LOG)
      .setTitle(`📋 FLIGHT LOG — ${pilot.callsign}`)
      .setDescription('```\n' +
        '═══════════════════════════════════════\n' +
        ` PILOT    : ${pilot.callsign}\n` +
        (pilot.acid ? ` ACID     : ${pilot.acid}\n` : '') +
        '═══════════════════════════════════════\n' +
        '```')
      .addFields(
        {
          name: '⏱ FLIGHT TIME',
          value: [
            `**Time Start:** ${fmtTs(session.startTs)}`,
            `**Time End:** ${fmtTs(Date.now())}`,
            `**Total Time:** \`${fmtDuration(duration)}\``,
          ].join('\n'),
          inline: false,
        },
        {
          name: '📍 LOCATION NOTES',
          value: locationNotes,
          inline: false,
        },
        {
          name: '🛫 DEPARTURE BASE',
          value: startBase
            ? `\`${startBase.icao}\` — ${startBase.name}\n${startBase.country}${startBase.service ? `\n*${startBase.service}*` : ''}`
            : 'Unknown / Airborne',
          inline: true,
        },
        {
          name: '🛬 LAST KNOWN BASE',
          value: endBase
            ? `\`${endBase.icao}\` — ${endBase.name}\n${endBase.country}${endBase.service ? `\n*${endBase.service}*` : ''}`
            : 'Unknown / Airborne',
          inline: true,
        },
      )
      .setFooter({ text: `MRP COMMAND · Patrol Log · ${nowZ()}` })
      .setTimestamp();

    await ch.send({ embeds: [e] });
  } catch (e) {
    console.error('[PatrolLog] Flight log error:', e.message);
  }
}

function buildLocationNotes(startBase, endBase, territories) {
  const lines = [];
  if (territories && territories.length) {
    lines.push(`**Monitored territories:** ${territories.join(', ')}`);
  }
  if (startBase && endBase && startBase.icao !== endBase.icao) {
    lines.push(`**Route:** \`${startBase.icao}\` → \`${endBase.icao}\``);
  } else if (startBase) {
    lines.push(`**Operating from:** \`${startBase.icao}\` — ${startBase.name}`);
  }
  if (startBase?.service) {
    lines.push(`**Unit:** ${startBase.service}`);
  }
  return lines.length ? lines.join('\n') : 'No base data available';
}

// ── SLASH COMMANDS ────────────────────────────────────────────────────────────
const CMDS = [
  new SlashCommandBuilder()
    .setName('pilot')
    .setDescription('Manage tracked pilots for patrol logging')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('add').setDescription('Register a pilot to track')
      .addStringOption(o => o.setName('callsign').setDescription('Full callsign e.g. [USAF]RAPTOR4').setRequired(true))
      .addStringOption(o => o.setName('acid').setDescription('GeoFS user ACID/ID (optional but recommended)').setRequired(false)))
    .addSubcommand(s => s.setName('remove').setDescription('Stop tracking a pilot')
      .addStringOption(o => o.setName('callsign').setDescription('Callsign to remove').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Show all tracked pilots'))
    .addSubcommand(s => s.setName('status').setDescription('Check if a pilot is online right now')
      .addStringOption(o => o.setName('callsign').setDescription('Callsign to check').setRequired(true))),

  new SlashCommandBuilder()
    .setName('patrolconfig')
    .setDescription('Configure patrol log channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('status_channel').setDescription('Channel for online/offline notifications')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('log_channel').setDescription('Channel for completed flight logs')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription('Show current patrol config')),
].map(c => c.toJSON());

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────────
async function handleInteraction(i) {
  if (!i.isChatInputCommand()) return false;
  if (i.commandName !== 'pilot' && i.commandName !== 'patrolconfig') return false;

  const gid = i.guildId;
  if (!gid) { await i.reply({ content: 'Server only.', ephemeral: true }); return true; }

  if (i.commandName === 'patrolconfig') {
    await handlePatrolConfig(i, gid);
    return true;
  }
  if (i.commandName === 'pilot') {
    await handlePilot(i, gid);
    return true;
  }
  return false;
}

async function handlePatrolConfig(i, gid) {
  const sub = i.options.getSubcommand();
  const cfg = loadPatrolCfg(gid);

  if (sub === 'status_channel') {
    const ch = i.options.getChannel('channel', true);
    cfg.statusChannel = ch.id;
    savePatrolCfg(gid, cfg);
    return i.reply({ content: `✅ Pilot status updates → <#${ch.id}>` });
  }
  if (sub === 'log_channel') {
    const ch = i.options.getChannel('channel', true);
    cfg.logChannel = ch.id;
    savePatrolCfg(gid, cfg);
    return i.reply({ content: `✅ Flight logs → <#${ch.id}>` });
  }
  if (sub === 'view') {
    const e = new EmbedBuilder().setColor(COL.LOG)
      .setTitle('⚙️ PATROL LOG CONFIG')
      .addFields(
        { name: 'Status Channel', value: cfg.statusChannel ? `<#${cfg.statusChannel}>` : '⚠️ Not set', inline: true },
        { name: 'Log Channel',    value: cfg.logChannel    ? `<#${cfg.logChannel}>`    : '⚠️ Not set', inline: true },
      )
      .setFooter({ text: nowZ() });
    return i.reply({ embeds: [e], ephemeral: true });
  }
}

async function handlePilot(i, gid) {
  const sub  = i.options.getSubcommand();
  const data = loadPilots(gid);

  if (sub === 'add') {
    const cs   = i.options.getString('callsign', true).trim();
    const acid = i.options.getString('acid') || null;
    const key  = cs.toUpperCase();

    if (data[key]) return i.reply({ content: `**${cs}** is already being tracked.`, ephemeral: true });

    data[key] = { callsign: cs, acid, addedBy: i.user.id, addedTs: Date.now() };
    savePilots(gid, data);

    const e = new EmbedBuilder().setColor(COL.ADD)
      .setTitle('✅ PILOT REGISTERED')
      .addFields(
        { name: 'Callsign', value: `\`${cs}\``, inline: true },
        { name: 'ACID',     value: acid ? `\`${acid}\`` : 'Not provided', inline: true },
        { name: 'Tracked',  value: `${Object.keys(data).length} pilots total`, inline: true },
      )
      .setDescription('Bot will now monitor this callsign and post status + flight logs.')
      .setFooter({ text: nowZ() });
    return i.reply({ embeds: [e] });
  }

  if (sub === 'remove') {
    const cs  = i.options.getString('callsign', true).trim().toUpperCase();
    if (!data[cs]) return i.reply({ content: `**${cs}** is not in the tracking list.`, ephemeral: true });
    delete data[cs];
    savePilots(gid, data);
    // clear any active session
    sessions.delete(`${gid}:${cs}`);
    return i.reply({ content: `✅ \`${cs}\` removed from tracking.` });
  }

  if (sub === 'list') {
    const pilots = Object.values(data);
    if (!pilots.length) return i.reply({ content: 'No pilots registered. Use `/pilot add` to start.', ephemeral: true });

    const lines = pilots.map(p => {
      const sessionKey = `${gid}:${p.callsign.toUpperCase()}`;
      const sess = sessions.get(sessionKey);
      const status = sess ? '🟢 ONLINE' : '🔴 OFFLINE';
      const base   = sess?.lastBase ? `@ \`${sess.lastBase.icao}\`` : '';
      return `${status} \`${p.callsign}\`${p.acid ? ` *(${p.acid})*` : ''} ${base}`;
    });

    const e = new EmbedBuilder().setColor(COL.LOG)
      .setTitle(`◈ TRACKED PILOTS — ${pilots.length} registered`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: nowZ() });
    return i.reply({ embeds: [e], ephemeral: true });
  }

  if (sub === 'status') {
    await i.deferReply();
    const cs      = i.options.getString('callsign', true).trim().toUpperCase();
    const pilot   = data[cs];
    if (!pilot) return i.editReply({ content: `**${cs}** is not registered. Use \`/pilot add\` first.` });

    const online  = await fetchOnlinePilots();
    const contact = findOnline(online, pilot.callsign, pilot.acid);
    const sessionKey = `${gid}:${cs}`;
    const sess    = sessions.get(sessionKey);

    const territories = loadTerritories(gid);
    const base = contact ? nearestBase(contact.lat, contact.lon, territories) : sess?.lastBase;

    const e = new EmbedBuilder()
      .setColor(contact ? COL.ONLINE : COL.OFFLINE)
      .setTitle(`${contact ? '🟢' : '🔴'} PILOT STATUS — ${pilot.callsign}`)
      .addFields(
        { name: 'Callsign', value: `\`${pilot.callsign}\``, inline: true },
        { name: 'ACID',     value: pilot.acid ? `\`${pilot.acid}\`` : '---', inline: true },
        { name: 'Status',   value: contact ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
        ...(contact ? [
          { name: 'Position',  value: `\`${contact.lat.toFixed(4)}, ${contact.lon.toFixed(4)}\``, inline: true },
          { name: 'Altitude',  value: `${Math.round(contact.alt)}ft`, inline: true },
          { name: 'Speed',     value: contact.spd != null ? `${Math.round(contact.spd)}kt` : '---', inline: true },
          { name: 'Base',      value: base ? `\`${base.icao}\` — ${base.name}` : 'Airborne / Unknown', inline: false },
        ] : []),
        ...(sess ? [
          { name: 'Flight started', value: fmtTs(sess.startTs), inline: true },
          { name: 'Duration so far', value: `\`${fmtDuration(Date.now() - sess.startTs)}\``, inline: true },
        ] : []),
      )
      .setFooter({ text: `MRP COMMAND · Patrol Log · ${nowZ()}` })
      .setTimestamp();
    return i.editReply({ embeds: [e] });
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
function init(client, dataDir) {
  _client  = client;
  _dataDir = dataDir || './data';
  loadBases();
  // Start monitoring loop
  setInterval(() => monitorPilots().catch(e => console.warn('[PatrolLog] Monitor:', e.message)), POLL_MS);
  console.log('[PatrolLog] Module ready.');
}

module.exports = { init, handleInteraction, CMDS };
