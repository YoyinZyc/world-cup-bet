import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient'; // 引入咱们配置好的客户端
import heroImg from './assets/hero.png';

// ====== 真正的云端同步适配器 ======
if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    async get(key, shared = false) {
      if (!shared) {
        const val = localStorage.getItem(key);
        if (val === null) throw new Error("Key not found");
        return { value: val };
      }

      const { data, error } = await supabase
        .from('kv_store')
        .select('value')
        .eq('key', key)
        .single();

      if (error || !data) throw new Error("Key not found");
      
      return { value: data.value }; 
    },

    async getMany(keys, shared = false) {
      if (!shared) {
        const result = {};
        for (const k of keys) {
          const val = localStorage.getItem(k);
          if (val !== null) result[k] = val;
        }
        return result;
      }
      const { data, error } = await supabase
        .from('kv_store')
        .select('key, value')
        .in('key', keys);
      
      if (error) throw error;
      
      const result = {};
      if (data) {
        data.forEach(row => {
          result[row.key] = row.value;
        });
      }
      return result;
    },

    async set(key, value, shared = false) {
      if (!shared) {
        localStorage.setItem(key, value);
        return true;
      }

      const { error } = await supabase
        .from('kv_store')
        .upsert({ 
          key: key, 
          value: value, 
          updated_at: new Date().toISOString() 
        });

      if (error) {
        console.error('Supabase Sync Error:', error);
        throw error;
      }
      return true;
    },

    async setMany(entries, shared = false) {
      if (!shared) {
        Object.entries(entries).forEach(([k, v]) => {
          localStorage.setItem(k, v);
        });
        return true;
      }
      const rows = Object.entries(entries).map(([k, v]) => ({
        key: k,
        value: v,
        updated_at: new Date().toISOString()
      }));

      const { error } = await supabase
        .from('kv_store')
        .upsert(rows);

      if (error) {
        console.error('Supabase Sync Error:', error);
        throw error;
      }
      return true;
    },

    async delete(key, shared = false) {
      if (!shared) {
        localStorage.removeItem(key);
        return true;
      }
      
      const { error } = await supabase
        .from('kv_store')
        .delete()
        .eq('key', key);
        
      if (error) throw error;
      return true;
    }
  };
}
// =============
const STARTING_CHIPS = 100;
const POLLING_INTERVAL_MS = 10000;
const ME_KEY = 'me-identity'; // personal (non-shared) storage: { name, sessionCode }
const SESSION_INDEX_KEY = 'session-index'; // shared: { [code]: { createdAt, label } } — just for existence checks

function sessionKey(code, suffix) {
  return `session:${code}:${suffix}`;
}

// ===== Two independent match pools =====
// A knockout-stage match has two separate, simultaneously-open pari-mutuel pools:
//   - "final": who ultimately advances -- home / away only, no draw (a knockout match always
//     has a winner eventually, whether decided in regulation, extra time, or penalties)
//   - "regulation": what the 90-minute scoreline is -- home / draw / away, settled independently
//     the moment regulation time ends, regardless of what happens afterward
// Each pool has its own stakes, its own share pricing, and is settled separately by the host.
// Chips staked go into the pool for that specific bet; after the host records the outcome,
// winners split the pool (stake back + proportional cut of the losers' stakes). If nobody backed
// the winning outcome, everyone's stake is refunded instead (nothing vanishes, nothing is created).

// Probabilities for the "regulation" pool (three-way: home / draw / away), driven by current score.
function regulationProbabilities(homeScore, awayScore) {
  const diff = homeScore - awayScore;
  const homeStrength = Math.exp(diff * 0.4);
  const awayStrength = Math.exp(-diff * 0.4);
  const drawStrength = 1.6 * Math.exp(-Math.abs(diff) * 0.25);
  const total = homeStrength + awayStrength + drawStrength;
  return { home: homeStrength / total, draw: drawStrength / total, away: awayStrength / total };
}

// Probabilities for the "final" pool (two-way: home / away only, no draw possible).
function finalProbabilities(homeScore, awayScore) {
  const diff = homeScore - awayScore;
  // squashed slightly vs. the raw regulation strengths, since a two-goal regulation lead means
  // less for who ultimately wins a knockout match than it does for the 90-minute scoreline itself
  const homeStrength = Math.exp(diff * 0.25);
  const awayStrength = Math.exp(-diff * 0.25);
  const total = homeStrength + awayStrength;
  return { home: homeStrength / total, away: awayStrength / total };
}

function poolProbabilities(poolKey, homeScore, awayScore) {
  return poolKey === 'final' ? finalProbabilities(homeScore, awayScore) : regulationProbabilities(homeScore, awayScore);
}

// Purely descriptive "reference odds" for display -- derived from the same probabilities used for
// pricing, so the number shown is directionally consistent with what a bettor will actually pay.
// IMPORTANT: because payouts come from a shared pool (not a fixed bookmaker promise), this number
// is a snapshot of "what the room currently thinks", not a guaranteed payout multiplier -- the
// UI must label it as a reference, not a promise.
function calcOdds(homeScore, awayScore, betType, poolKey = 'regulation') {
  const probs = poolProbabilities(poolKey, homeScore, awayScore);
  const p = probs[betType];
  if (!p) return 2.0;
  return Math.min(50, +(1 / p).toFixed(2));
}

// elapsedRatio: 0 (kickoff) to 1 (full time), clamped.
// priorStakeOnDirection: total chips already staked on this direction in this specific pool so far.
function sharePricePerChip(poolKey, direction, elapsedRatio, priorStakeOnDirection, homeScore, awayScore) {
  const clampedElapsed = Math.max(0, Math.min(1, elapsedRatio));
  const timeFactor = 1 + clampedElapsed * 1.5; // 1.0x at kickoff -> 2.5x at full time
  const heatFactor = 1 + Math.sqrt(Math.max(0, priorStakeOnDirection)) * 0.02;
  const probs = poolProbabilities(poolKey, homeScore, awayScore);
  const fallback = poolKey === 'final' ? 0.5 : 0.33;
  const p = probs[direction] || fallback;
  const scoreFactor = 0.5 + p * 2; // favored side gets pricier shares, underdog gets cheaper shares
  return +(timeFactor * heatFactor * scoreFactor).toFixed(4);
}

function sharesForStake(chips, pricePerShare) {
  if (!pricePerShare || pricePerShare <= 0) return 0;
  return chips / pricePerShare;
}

// Settles one pool (either "final" or "regulation") once the host records its outcome.
// poolBets: [{ id, player, direction, amount, shares }] — all pending bets for this specific pool.
// Returns { payouts: { [player]: totalChipsReceived }, betPayouts: { [betId]: payoutAmount }, refunded: boolean }
function settlePool(poolBets, winningDirection) {
  const winners = poolBets.filter((b) => b.direction === winningDirection);
  const losers = poolBets.filter((b) => b.direction !== winningDirection);
  const loserPool = losers.reduce((sum, b) => sum + b.amount, 0);
  const winnerTotalShares = winners.reduce((sum, b) => sum + b.shares, 0);

  if (winners.length === 0 || winnerTotalShares <= 0) {
    // nobody backed the winning outcome -- refund everyone's stake, nothing lost, nothing gained
    const refunds = {};
    const betPayouts = {};
    poolBets.forEach((b) => {
      refunds[b.player] = (refunds[b.player] || 0) + b.amount;
      betPayouts[b.id] = b.amount;
    });
    return { payouts: refunds, betPayouts, refunded: true };
  }

  const payouts = {};
  const betPayouts = {};
  winners.forEach((b) => {
    const bonus = loserPool * (b.shares / winnerTotalShares);
    const total = b.amount + bonus;
    payouts[b.player] = (payouts[b.player] || 0) + total;
    betPayouts[b.id] = total;
  });
  return { payouts, betPayouts, refunded: false };
}

// ===== In-match proposition bets (event bets) =====
// These stay as a flat system payout (not pool-based): the outcome of "does a red card happen"
// isn't naturally split into a betting pool the way a match result is, since there's no symmetric
// "someone bet the opposite" counterpart baked into the UI. Odds are host-editable. The host can
// also add brand-new event types mid-match (e.g. "extra time?", "penalty shootout?"), setting the
// odds manually since there's no natural default for an arbitrary host-defined proposition.
const DEFAULT_EVENT_ODDS = {
  next_goal_home: 1.6,
  next_goal_away: 1.6,
  red_card: 4.5,
  penalty: 4.0,
  var_review: 2.5,
  first_half_no_goals: 2.8,
  second_half_no_goals: 3.2,
  extra_time_occurs: 3.5,
  penalty_shootout_occurs: 4.8,
};

function eventOdds(eventKey, homeScore, awayScore, overrides) {
  const totalGoals = homeScore + awayScore;

  if (eventKey === 'next_goal_home' || eventKey === 'next_goal_away') {
    if (overrides && overrides[eventKey] != null) return overrides[eventKey];
    return 1.6; // Default next goal odds
  }

  if (overrides && overrides[eventKey] != null) return overrides[eventKey];

  let odds = DEFAULT_EVENT_ODDS[eventKey] || 2.0;
  if (totalGoals >= 3 && (eventKey === 'red_card' || eventKey === 'penalty')) {
    odds = +(odds * 1.15).toFixed(2);
  }
  return +odds.toFixed(2);
}

const EVENT_ODDS_MIN = 1.1;
const EVENT_ODDS_MAX = 6; // keeps host-set odds within the existing 1.7x~4.5x-ish range, no runaway payouts

// Fixed proposition events. The two "next goal" variants need the real team names baked into
// their default label (not the generic "主队"/"客队"), since a room full of people watching e.g.
// Argentina vs Brazil shouldn't have to mentally translate "主队" back into which team that is.
// Events with no team-specific wording (cards, penalty, VAR) don't need the team names at all.
function buildFixedEvents(homeTeam, awayTeam, matchMode) {
  const home = homeTeam || '主队';
  const away = awayTeam || '客队';
  const list = [
    { key: 'next_goal_home', label: `下一球：${home}进` },
    { key: 'next_goal_away', label: `下一球：${away}进` },
    { key: 'first_half_no_goals', label: '上半场无进球' },
    { key: 'second_half_no_goals', label: '下半场无进球' },
    { key: 'red_card', label: '出现红牌' },
    { key: 'penalty', label: '出现点球（非点球大战）' },
    { key: 'var_review', label: 'VAR介入' },
  ];
  if (matchMode === 'knockout') {
    list.push(
      { key: 'extra_time_occurs', label: '有加时赛' },
      { key: 'penalty_shootout_occurs', label: '有点球大战' }
    );
  }
  return list;
}

function newMatchId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function newFreshMatch(home, away, matchMode) {
  return {
    home: home || '主队',
    away: away || '客队',
    homeScore: 0,
    awayScore: 0,
    createdAt: Date.now(),
    status: 'live', // 'live' | 'ended'
    matchMode: matchMode === 'knockout' ? 'knockout' : 'group', // 'group' = regulation pool only; 'knockout' = final + regulation pools both open
    clockStatus: 'not_started', // 'not_started' | 'running' -- host starts the clock explicitly
    kickoffAt: null, // timestamp (ms) when the clock was last (re)started; null while stopped
    frozenElapsedMinutes: 0, // minutes accumulated before the most recent pause, carried forward on resume
    // Authoritative pricing minute, written ONLY by the host's device and read by everyone
    // (including the host) for share-price calculations. This avoids every device computing its
    // own elapsed time off its own local clock, which can disagree by minutes if phones' clocks
    // drift -- since the pricing bucket only changes every 10 minutes, a client whose clock reads
    // even a little differently could land in the wrong bucket and see a meaningfully different
    // price than everyone else for the same bet. The host is the single source of truth here;
    // everyone (including the host) prices off this field, never off their own Date.now() math.
    broadcastPricingMinutes: 0,
    eventOddsOverrides: {}, // { [eventKey]: hostSetOdds } -- host can override the default event odds
    eventLabelOverrides: {}, // { [eventKey]: hostSetLabel } -- host can rename a fixed event's display text
    customEvents: [], // [{ key, label, odds }] -- host-added propositions (e.g. "extra time?"), name and odds both set by host
  };
}

// Real elapsed minutes since kickoff, clamped to [0, 90]. Returns 0 if the clock hasn't started.
// If the clock was paused, `frozenElapsedMinutes` holds the minute count at pause time, and the
// clock isn't running again until the host restarts it (kickoffAt gets reset to "now" on restart,
// with frozenElapsedMinutes carried forward as a base offset).
// NOTE: this is used for the live minute-counter DISPLAY only (cosmetic, each device showing its
// own best-effort estimate is fine for that). It must NOT be used for pricing -- see
// `broadcastPricingMinutes` on the match object, which is the single shared source of truth
// for anything that affects how many chips a bet actually costs.
function computeElapsedMinutes(match, now) {
  if (!match) return 0;
  const base = match.frozenElapsedMinutes || 0;
  if (match.clockStatus !== 'running' || !match.kickoffAt) return base;
  const rawMinutes = base + (now - match.kickoffAt) / 60000;
  return Math.max(0, Math.min(90, rawMinutes));
}

// Pricing bucket derived from a given elapsed-minutes number, re-bucketing every 10 minutes so
// odds/share-price don't drift on every poll (minute 7 and minute 9 both bucket to 0, minute 34
// buckets to 30). Takes a plain number rather than computing it locally, so callers can pass
// either the host's freshly-computed local time (when the host is writing the broadcast value)
// or the shared `match.broadcastPricingMinutes` (when anyone, including the host, is pricing a bet).
function bucketPricingMinutes(rawMinutes) {
  const clamped = Math.max(0, Math.min(90, rawMinutes || 0));
  return Math.floor(clamped / 10) * 10;
}

function normalizeCode(raw) {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

// Compute a fun title per player based on their betting history in this room
function computeTitles(players, bets) {
  const names = Object.keys(players);
  if (names.length === 0) return { titles: {}, stats: {} };

  const stats = {};
  names.forEach((n) => {
    stats[n] = { won: 0, lost: 0, pending: 0, refunded: 0, totalBets: 0, biggestWin: 0, biggestWinLabel: '', longshotOdds: 0, longshotLabel: '', longshotWon: false };
  });

  bets.forEach((b) => {
    const s = stats[b.player];
    if (!s) return;
    s.totalBets += 1;
    const isPool = b.betClass === 'pool';
    if (b.status === 'won') {
      s.won += 1;
      const profit = isPool ? Math.round((b.payout || 0) - b.amount) : Math.round(b.amount * b.odds) - b.amount;
      if (profit > s.biggestWin) { s.biggestWin = profit; s.biggestWinLabel = b.label; }
    } else if (b.status === 'lost') {
      s.lost += 1;
    } else if (b.status === 'refunded') {
      s.refunded += 1; // neutral outcome -- doesn't count toward win rate either way
    } else {
      s.pending += 1;
    }
    // "upset king" only considers flat-odds event bets, since pool bets don't have a fixed
    // odds number to compare against (their payout depends on the whole pool, not a quoted price)
    if (!isPool && b.odds > s.longshotOdds) {
      s.longshotOdds = b.odds;
      s.longshotLabel = b.label;
      s.longshotWon = b.status === 'won';
    }
  });

  const titles = {};
  const sortedByChips = [...names].sort((a, b) => players[b] - players[a] || a.localeCompare(b));

  // Champion: most chips
  if (sortedByChips.length > 0) titles[sortedByChips[0]] = { emoji: '👑', label: '本场冠军' };
  // Bottom: fewest chips (only if more than 1 player)
  if (sortedByChips.length > 1) {
    const last = sortedByChips[sortedByChips.length - 1];
    if (!titles[last]) titles[last] = { emoji: '🍺', label: '本场垫底' };
  }

  // Upset king: won the bet with highest odds among all won bets
  let upsetName = null, upsetOdds = 0;
  names.forEach((n) => {
    if (stats[n].longshotWon && stats[n].longshotOdds > upsetOdds) {
      upsetOdds = stats[n].longshotOdds;
      upsetName = n;
    }
  });
  if (upsetName && !titles[upsetName]) titles[upsetName] = { emoji: '🎯', label: '爆冷之王' };

  // Steady hand: highest win rate with at least 3 resolved bets
  let steadyName = null, steadyRate = -1;
  names.forEach((n) => {
    const resolved = stats[n].won + stats[n].lost;
    if (resolved >= 3) {
      const rate = stats[n].won / resolved;
      if (rate > steadyRate) { steadyRate = rate; steadyName = n; }
    }
  });
  if (steadyName && !titles[steadyName]) titles[steadyName] = { emoji: '🧊', label: '稳健派' };

  // Most active bettor
  let activeName = null, activeCount = 0;
  names.forEach((n) => {
    if (stats[n].totalBets > activeCount) { activeCount = stats[n].totalBets; activeName = n; }
  });
  if (activeName && activeCount >= 3 && !titles[activeName]) titles[activeName] = { emoji: '🔥', label: '下注狂魔' };

  return { titles, stats };
}

export default function WorldCupBetting() {
  const [screen, setScreen] = useState('loading'); // loading | join | board | leaderboard | matches
  const [showWelcomeBanner, setShowWelcomeBanner] = useState(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false); // true once the first shared-data load has genuinely succeeded (or genuinely confirmed empty) -- distinguishes "room has no matches" from "haven't successfully read yet"
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [sessionCode, setSessionCode] = useState(null);
  const [players, setPlayers] = useState({});
  const [myName, setMyName] = useState('');
  const [matches, setMatches] = useState({});
  const [activeMatchId, setActiveMatchId] = useState(null);
  const [bets, setBets] = useState([]);
  const [customEvent, setCustomEvent] = useState('');
  const [customOdds, setCustomOdds] = useState('2.0');
  const [wager, setWager] = useState(10);
  const [toast, setToast] = useState('');
  const [hostName, setHostName] = useState(null);
  const [editingMatch, setEditingMatch] = useState(false);
  const [matchDraft, setMatchDraft] = useState({ home: '主队', away: '客队' });
  const [newMatchDraft, setNewMatchDraft] = useState({ home: '', away: '', mode: 'group' });
  const pollRef = useRef(null);
  const matchesRef = useRef(matches);
  const playersRef = useRef(players);
  const betsRef = useRef(bets);
  useEffect(() => { matchesRef.current = matches; }, [matches]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { betsRef.current = bets; }, [bets]);

  // Auto-dismiss welcome back banner after 4 seconds
  useEffect(() => {
    if (showWelcomeBanner) {
      const timer = setTimeout(() => {
        setShowWelcomeBanner(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [showWelcomeBanner]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  }, []);

  // One-time startup diagnostic: verify window.storage actually works in this runtime before
  // relying on it for anything -- testing BOTH personal (shared:false) and shared (shared:true)
  // modes separately, since match/player/bet/host data all uses shared:true and that path could
  // behave differently from personal storage. If persistent storage is unavailable or broken
  // here (wrong plan, artifact not actually published in the way storage needs, or some other
  // runtime issue), every write in the app could silently fail and every "created successfully"
  // toast would be a lie -- which is exactly what "I created a match and it vanished on refresh"
  // looks like from the outside. Surface this clearly at startup instead of only discovering
  // it indirectly, one failed feature at a time.
  const [storageBroken, setStorageBroken] = useState(false);
  const [storageDiagnostic, setStorageDiagnostic] = useState(''); // human-readable detail for debugging, shown alongside the warning
  useEffect(() => {
    (async () => {
      if (!window.storage || typeof window.storage.set !== 'function' || typeof window.storage.get !== 'function') {
        setStorageBroken(true);
        setStorageDiagnostic('window.storage 不存在或不是预期的接口');
        return;
      }

      const probeSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // test personal storage (shared: false)
      try {
        const key = `__probe_personal_${probeSuffix}`;
        await window.storage.set(key, 'ok', false);
        const readBack = await window.storage.get(key, false);
        if (!readBack || readBack.value !== 'ok') {
          setStorageBroken(true);
          setStorageDiagnostic('个人存储（shared:false）写入后读取校验失败');
          return;
        }
        try { await window.storage.delete(key, false); } catch (e) {}
      } catch (e) {
        setStorageBroken(true);
        setStorageDiagnostic(`个人存储（shared:false）操作抛出异常：${e && e.message ? e.message : String(e)}`);
        return;
      }

      // test shared storage (shared: true) -- this is the mode actually used for match/player/host data
      try {
        const key = `__probe_shared_${probeSuffix}`;
        await window.storage.set(key, 'ok', true);
        const readBack = await window.storage.get(key, true);
        if (!readBack || readBack.value !== 'ok') {
          setStorageBroken(true);
          setStorageDiagnostic('共享存储（shared:true）写入后立即读取校验失败 -- 这正是比赛数据用的模式');
          return;
        }
        try { await window.storage.delete(key, true); } catch (e) {}
      } catch (e) {
        setStorageBroken(true);
        setStorageDiagnostic(`共享存储（shared:true）操作抛出异常：${e && e.message ? e.message : String(e)}`);
        return;
      }
    })();
  }, []);

  const loadAll = useCallback(async (code) => {
    if (!code) return { ok: false };
    const keys = [
      sessionKey(code, 'matches'),
      sessionKey(code, 'active-match'),
      sessionKey(code, 'players'),
      sessionKey(code, 'bets'),
      sessionKey(code, 'host'),
    ];

    try {
      const data = await window.storage.getMany(keys, true);

      const applyIfPresent = (key, apply) => {
        const val = data[key];
        if (val !== undefined && val !== null) {
          try { apply(JSON.parse(val)); } catch (e) {}
        }
      };

      applyIfPresent(sessionKey(code, 'matches'), setMatches);
      applyIfPresent(sessionKey(code, 'active-match'), setActiveMatchId);
      applyIfPresent(sessionKey(code, 'players'), setPlayers);
      applyIfPresent(sessionKey(code, 'bets'), setBets);
      applyIfPresent(sessionKey(code, 'host'), setHostName);

      return { ok: true };
    } catch (e) {
      console.error("Failed to load room data:", e);
      return { ok: false };
    }
  }, []);

  // When the tab comes back from the background (phone locked, switched apps, browser
  // backgrounded for a while), mobile browsers commonly throttle or fully freeze setInterval
  // timers -- so the regular 3s poll silently stops firing for however long the page was
  // hidden. The state on screen (matches, host, scores, bets) is left showing whatever it was
  // at the moment the tab went to the background, which can look like "the match disappeared"
  // or "I'm not the host anymore" even though the shared data was never actually touched --
  // this device just stopped listening for updates. Force an immediate refetch (with the same
  // retry-on-failure protection as the initial load) the moment the page becomes visible again,
  // rather than waiting for the next scheduled poll tick to eventually catch up.
  const forceResyncRef = useRef(null);
  useEffect(() => {
    forceResyncRef.current = async (code) => {
      if (!code) return;
      // loadAll no longer has a "failed, must retry" outcome -- a missing key is just an empty
      // state, not a failure -- so a single call is enough. The next scheduled 3s poll will pick
      // up anything that appears later.
      await loadAll(code);
    };
  }, [loadAll]);

  // Tracks when the tab was last hidden, so we can tell "briefly switched apps" (silent resync
  // is enough) apart from "backgrounded for a long time" (a full page reload is the safer bet).
  // A long background period is exactly the scenario most likely to leave this device's timers,
  // in-flight requests, or React state in some browser-specific half-broken condition that a
  // silent resync might not fully recover from -- a full reload re-runs the entire reconnect
  // flow from scratch, which is the most thoroughly-tested path back to a correct state.
  const hiddenAtRef = useRef(null);
  const FULL_RELOAD_THRESHOLD_MS = 60000; // 1 minute

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      if (document.visibilityState !== 'visible' || !sessionCode) return;

      const hiddenDuration = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = null;

      if (hiddenDuration >= FULL_RELOAD_THRESHOLD_MS) {
        // Backgrounded long enough that a silent resync isn't trustworthy on its own --
        // reload the whole page so every piece of state (not just matches/host/bets, but also
        // things like in-progress timers) gets rebuilt from scratch via the normal reconnect path.
        window.location.reload();
        return;
      }

      if (forceResyncRef.current) forceResyncRef.current(sessionCode);
      // also restart the poll interval -- after a background period, the previous setInterval
      // may be in an unreliable state (some browsers don't resume a timer's original cadence
      // cleanly after a suspend), so replace it with a fresh one
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => loadAll(sessionCode), POLLING_INTERVAL_MS);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Some mobile browsers fire 'pageshow' (with persisted=true for back/forward-cache restores)
    // more reliably than visibilitychange in certain backgrounding scenarios -- listen to both
    // as a belt-and-suspenders measure since the cost of an extra sync is low. pageshow doesn't
    // carry its own "how long were we hidden" signal as cleanly, so it always does the lighter
    // silent resync rather than triggering a reload itself; visibilitychange remains the primary
    // path for the reload decision since it fires reliably on both hide and show.
    const handlePageShow = () => {
      if (sessionCode && forceResyncRef.current) {
        forceResyncRef.current(sessionCode);
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(() => loadAll(sessionCode), POLLING_INTERVAL_MS);
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [sessionCode, loadAll]);


  // try auto-reconnect using personal storage
  useEffect(() => {
    (async () => {
      try {
        const saved = await window.storage.get(ME_KEY, false);
        if (saved && saved.value) {
          const parsed = JSON.parse(saved.value);
          if (parsed && parsed.name && parsed.sessionCode) {
            setMyName(parsed.name);
            setSessionCode(parsed.sessionCode);
            // Load the room's shared data once. A missing key just means "empty so far", not a
            // failure, so there's nothing to retry -- the poll below keeps everything current
            // from here on.
            await loadAll(parsed.sessionCode);
            setInitialLoadDone(true);
            setScreen('board');
            pollRef.current = setInterval(() => loadAll(parsed.sessionCode), POLLING_INTERVAL_MS);
            return;
          }
        }
      } catch (e) {}
      setInitialLoadDone(true);
      setScreen('join');
    })();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadAll]);

  // Real-time synchronization using Supabase Postgres Changes
  useEffect(() => {
    if (!sessionCode) return;

    const keys = [
      sessionKey(sessionCode, 'matches'),
      sessionKey(sessionCode, 'active-match'),
      sessionKey(sessionCode, 'players'),
      sessionKey(sessionCode, 'bets'),
      sessionKey(sessionCode, 'host'),
    ];

    const channel = supabase
      .channel(`room:${sessionCode}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kv_store',
        },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row || !row.key) return;

          // Only process updates to keys in this session
          if (keys.includes(row.key)) {
            if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
              try {
                const parsedVal = JSON.parse(row.value);
                if (row.key === sessionKey(sessionCode, 'matches')) {
                  setMatches(parsedVal);
                } else if (row.key === sessionKey(sessionCode, 'active-match')) {
                  setActiveMatchId(parsedVal);
                } else if (row.key === sessionKey(sessionCode, 'players')) {
                  setPlayers(parsedVal);
                } else if (row.key === sessionKey(sessionCode, 'bets')) {
                  setBets(parsedVal);
                } else if (row.key === sessionKey(sessionCode, 'host')) {
                  setHostName(parsedVal);
                }
              } catch (e) {
                console.error("Realtime update parsing error:", e);
              }
            } else if (payload.eventType === 'DELETE') {
              if (row.key === sessionKey(sessionCode, 'matches')) {
                setMatches({});
              } else if (row.key === sessionKey(sessionCode, 'active-match')) {
                setActiveMatchId(null);
              } else if (row.key === sessionKey(sessionCode, 'players')) {
                setPlayers({});
              } else if (row.key === sessionKey(sessionCode, 'bets')) {
                setBets([]);
              } else if (row.key === sessionKey(sessionCode, 'host')) {
                setHostName(null);
              }
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionCode]);

  // Every persist* function below writes to SHARED storage and must succeed for other devices
  // to ever see this data -- unlike the read side (where a missing key can legitimately mean
  // "nothing here yet"), a failed write here means the action the user just took (creating a
  // match, placing a bet, becoming host) only exists in this device's local React state and
  // will vanish the moment this tab is closed or refreshed. Silently swallowing that failure
  // was the root cause of "I created a match and it disappeared on refresh" -- the UI showed
  // a success toast regardless of whether the underlying write actually landed. Each function
  // now returns whether the write succeeded, and callers surface a clear error toast on failure
  // instead of claiming success.
  const persistPlayers = async (code, next) => {
    try {
      let latest = {};
      try {
        const p = await window.storage.get(sessionKey(code, 'players'), true);
        if (p && p.value) latest = JSON.parse(p.value);
      } catch (e) {}
      const merged = { ...latest, ...next };
      await window.storage.set(sessionKey(code, 'players'), JSON.stringify(merged), true);
      setPlayers(merged);
      return true;
    } catch (e) {
      showToast('⚠️ 筹码数据保存失败，请检查网络后重试');
      return false;
    }
  };

  const persistMatches = async (code, next) => {
    try {
      let latest = {};
      try {
        const m = await window.storage.get(sessionKey(code, 'matches'), true);
        if (m && m.value) latest = JSON.parse(m.value);
      } catch (e) {}
      const merged = { ...latest, ...next };
      await window.storage.set(sessionKey(code, 'matches'), JSON.stringify(merged), true);
      setMatches(merged);
      return true;
    } catch (e) {
      showToast('⚠️ 比赛数据保存失败，请检查网络后重试');
      return false;
    }
  };

  const persistActiveMatch = async (code, id) => {
    try {
      await window.storage.set(sessionKey(code, 'active-match'), JSON.stringify(id), true);
      setActiveMatchId(id);
      return true;
    } catch (e) {
      showToast('⚠️ 切换比赛保存失败，请检查网络后重试');
      return false;
    }
  };

  const persistBets = async (code, next) => {
    try {
      let latest = [];
      try {
        const b = await window.storage.get(sessionKey(code, 'bets'), true);
        if (b && b.value) latest = JSON.parse(b.value);
      } catch (e) {}

      const getBetTime = (bet) => {
        const ts = parseInt(bet.id?.split('-')[0], 10);
        return isNaN(ts) ? 0 : ts;
      };

      const map = new Map();
      latest.forEach(b => map.set(b.id, b));
      next.forEach(b => {
        if (!map.has(b.id)) {
          map.set(b.id, b);
        } else {
          // If the bet already exists, prefer the one with resolved status (won/lost/refunded vs pending)
          const remoteBet = map.get(b.id);
          if (remoteBet.status === 'pending' && b.status !== 'pending') {
            map.set(b.id, b);
          }
        }
      });

      const merged = Array.from(map.values()).sort((a, b) => getBetTime(b) - getBetTime(a));
      await window.storage.set(sessionKey(code, 'bets'), JSON.stringify(merged), true);
      setBets(merged);
      return true;
    } catch (e) {
      showToast('⚠️ 下注数据保存失败，请检查网络后重试');
      return false;
    }
  };

  const persistHost = async (code, name) => {
    try {
      await window.storage.set(sessionKey(code, 'host'), JSON.stringify(name), true);
      setHostName(name);
      return true;
    } catch (e) {
      showToast('⚠️ 主持人身份保存失败，请检查网络后重试');
      return false;
    }
  };

  const joinGame = async () => {
    const trimmedName = name.trim();
    const code = normalizeCode(roomCode);
    if (!trimmedName) { showToast('请输入你的名字'); return; }
    if (!code) { showToast('请输入房间码（没有就自己起一个新的）'); return; }

    // load whatever exists for this room (may be nothing — new room)
    await loadAll(code);
    let current = {};
    try {
      const p = await window.storage.get(sessionKey(code, 'players'), true);
      if (p && p.value) current = JSON.parse(p.value);
    } catch (e) {}

    const isNewRoom = Object.keys(current).length === 0;

    if (!current[trimmedName]) {
      current = { ...current, [trimmedName]: STARTING_CHIPS };
      const success = await persistPlayers(code, current);
      if (!success) return;
      showToast(isNewRoom ? `新房间「${code}」已创建，欢迎 ${trimmedName}` : `欢迎 ${trimmedName}，获得 ${STARTING_CHIPS} 筹码`);
    } else {
      setPlayers(current);
      setShowWelcomeBanner(trimmedName);
      showToast(`欢迎回来，${trimmedName}`);
    }

    // first person to ever join a room becomes its sole host
    let curHost = null;
    try {
      const h = await window.storage.get(sessionKey(code, 'host'), true);
      curHost = h && h.value ? JSON.parse(h.value) : null;
    } catch (e) {}
    if (!curHost) {
      await persistHost(code, trimmedName);
      showToast(`${trimmedName} 是「${code}」房间的主持人`);
    }

    // sync active match pointer if one already exists in this room; do NOT auto-create a
    // placeholder match -- an empty room should prompt the host to create the first match
    // themselves (picking group/knockout mode and real team names) rather than silently
    // starting a "主队 vs 客队" match nobody asked for
    let curMatches = {};
    try {
      const m = await window.storage.get(sessionKey(code, 'matches'), true);
      if (m && m.value) curMatches = JSON.parse(m.value);
    } catch (e) {}
    if (curMatches && Object.keys(curMatches).length > 0) {
      let curActive = null;
      try {
        const a = await window.storage.get(sessionKey(code, 'active-match'), true);
        curActive = a && a.value ? JSON.parse(a.value) : null;
      } catch (e) {}
      if (!curActive || !curMatches[curActive]) {
        const firstLive = Object.entries(curMatches).find(([, v]) => v.status === 'live');
        await persistActiveMatch(code, firstLive ? firstLive[0] : Object.keys(curMatches)[0]);
      }
    }

    setMyName(trimmedName);
    setSessionCode(code);
    try { await window.storage.set(ME_KEY, JSON.stringify({ name: trimmedName, sessionCode: code }), false); } catch (e) {}
    pollRef.current = setInterval(() => loadAll(code), POLLING_INTERVAL_MS);
    setInitialLoadDone(true);
    // brand-new room + no matches yet + this person is the host -> take them straight to match
    // creation instead of dropping them on an empty board they'd have to navigate away from anyway
    const noMatchesYet = !curMatches || Object.keys(curMatches).length === 0;
    setScreen(isNewRoom && noMatchesYet ? 'matches' : 'board');
  };

  const leaveRoom = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    try { await window.storage.delete(ME_KEY, false); } catch (e) {}
    setMyName('');
    setSessionCode(null);
    setPlayers({});
    setMatches({});
    setBets([]);
    setHostName(null);
    setName('');
    setRoomCode('');
    setInitialLoadDone(false);
    setScreen('join');
  };

  const hasMatch = !!(activeMatchId && matches[activeMatchId]);
  const currentMatch = hasMatch ? matches[activeMatchId] : newFreshMatch('主队', '客队');

  // ticks every few seconds so the displayed match clock advances live without a full data poll.
  // Kept short (not a full 60s) because mobile browsers can throttle background timers, and a
  // shorter interval means any missed tick is barely noticeable rather than looking "frozen".
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const isHost = !!myName && myName === hostName;

  // Host-only: periodically compute the real elapsed time off THIS device's clock and broadcast
  // the resulting 10-minute pricing bucket to shared storage, so every device (including the
  // host itself) prices pool bets off the same shared number instead of each computing its own
  // estimate from its own possibly-drifted system clock.
  useEffect(() => {
    if (!isHost || !activeMatchId || !sessionCode) return;
    const tick = async () => {
      const m = matchesRef.current[activeMatchId];
      if (!m || m.clockStatus !== 'running') return;
      const rawMinutes = computeElapsedMinutes(m, Date.now());
      const bucket = bucketPricingMinutes(rawMinutes);
      if (m.broadcastPricingMinutes === bucket) return; // no change, skip the write
      const next = { ...matchesRef.current, [activeMatchId]: { ...m, broadcastPricingMinutes: bucket } };
      matchesRef.current = next;
      await persistMatches(sessionCode, next);
    };
    tick(); // run once immediately so a freshly-started clock broadcasts right away
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [isHost, activeMatchId, sessionCode]);

  const myChips = players[myName] || 0;
  const pendingEventBets = bets.filter((b) => b.status === 'pending' && b.matchId === activeMatchId && b.betClass === 'event');
  const myBets = bets.filter((b) => b.player === myName && b.matchId === activeMatchId);
  const leaderboard = Object.entries(players).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const { titles: playerTitles = {}, stats: playerStats = {} } = computeTitles(players, bets);
  const matchList = Object.entries(matches).sort((a, b) => a[1].createdAt - b[1].createdAt);

  const liveElapsedMinutes = computeElapsedMinutes(currentMatch, nowTick); // display-only, cosmetic
  // pricing NEVER computes off this device's own clock -- it reads the host-broadcast value from
  // shared storage, so every device (including the host) prices bets identically regardless of
  // how accurate any individual phone's system clock is
  const pricingMinutes = currentMatch.broadcastPricingMinutes || 0;
  const elapsedRatio = pricingMinutes / 90;

  // Bundles everything the UI needs to render and bet into a specific pool ("final" or "regulation").
  function buildPoolView(poolKey) {
    const directions = poolKey === 'final' ? ['home', 'away'] : ['home', 'draw', 'away'];
    const poolBets = bets.filter((b) => b.matchId === activeMatchId && b.betClass === 'pool' && b.poolKey === poolKey && b.status === 'pending');
    const stakeByDirection = {};
    directions.forEach((d) => { stakeByDirection[d] = 0; });
    poolBets.forEach((b) => { stakeByDirection[b.direction] = (stakeByDirection[b.direction] || 0) + b.amount; });
    const sharePrices = {};
    const odds = {};
    directions.forEach((d) => {
      sharePrices[d] = sharePricePerChip(poolKey, d, elapsedRatio, stakeByDirection[d], currentMatch.homeScore, currentMatch.awayScore);
      odds[d] = calcOdds(currentMatch.homeScore, currentMatch.awayScore, d, poolKey);
    });
    const totalChips = poolBets.reduce((s, b) => s + b.amount, 0);
    return { poolKey, directions, poolBets, stakeByDirection, sharePrices, odds, totalChips };
  }

  const finalPool = buildPoolView('final');
  const regulationPool = buildPoolView('regulation');
  const isKnockout = currentMatch.matchMode === 'knockout';

  const [pendingBetConfirm, setPendingBetConfirm] = useState(null);
  // event confirm shape: { kind: 'event', betKey, label, odds, amount }
  // pool confirm shape:  { kind: 'pool', poolKey, direction, label, amount, pricePerShare, shares }

  const cancelBetConfirm = () => setPendingBetConfirm(null);

  // ----- Event bets: flat system payout, host-editable odds -----
  const requestEventBet = (betKey, label, odds) => {
    if (!myName || !activeMatchId || !sessionCode) return;
    const amount = Math.floor(Number(wager));
    if (!amount || amount <= 0) { showToast('请输入下注筹码数'); return; }
    const freshChips = playersRef.current[myName] || 0;
    if (amount > freshChips) { showToast('筹码不够啦'); return; }
    if (currentMatch.status !== 'live') { showToast('这场比赛已结束，不能下注'); return; }
    setPendingBetConfirm({ kind: 'event', betKey, label, odds, amount });
  };

  const placeCustomBet = () => {
    const label = customEvent.trim();
    const odds = Number(customOdds);
    if (!label) { showToast('请输入事件描述'); return; }
    if (!odds || odds <= 1) { showToast('赔率需大于1'); return; }
    if (odds > 20) { showToast('赔率最高设置到20x，太夸张啦'); return; }
    requestEventBet(`custom-${Date.now()}`, label, odds);
  };

  // ----- Match pool bets: pari-mutuel, price-per-share rises with time/heat/score -----
  // poolKey is 'final' (win/lose) or 'regulation' (win/draw/lose)
  const requestPoolBet = (poolKey, direction, label) => {
    if (!myName || !activeMatchId || !sessionCode) return;
    const amount = Math.floor(Number(wager));
    if (!amount || amount <= 0) { showToast('请输入下注筹码数'); return; }
    const freshChips = playersRef.current[myName] || 0;
    if (amount > freshChips) { showToast('筹码不够啦'); return; }
    if (currentMatch.status !== 'live') { showToast('这场比赛已结束，不能下注'); return; }
    const pool = poolKey === 'final' ? finalPool : regulationPool;
    const pricePerShare = pool.sharePrices[direction];
    const shares = sharesForStake(amount, pricePerShare);
    setPendingBetConfirm({ kind: 'pool', poolKey, direction, label, amount, pricePerShare, shares });
  };

  const confirmBet = async () => {
    const pending = pendingBetConfirm;
    if (!pending) return;
    setPendingBetConfirm(null);

    const oldChips = playersRef.current[myName] || 0;
    if (pending.amount > oldChips) { showToast('筹码不够啦'); return; } // re-check in case state moved since the modal opened

    const newPlayers = { ...playersRef.current, [myName]: oldChips - pending.amount };
    
    // Step 1: Write chips deduction to DB first
    const successPlayers = await persistPlayers(sessionCode, newPlayers);
    if (!successPlayers) {
      // Aborted. persistPlayers has already triggered toast.
      return;
    }
    
    // Update local players ref
    playersRef.current = newPlayers;

    // Build the bet object
    let bet;
    if (pending.kind === 'event') {
      bet = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        matchId: activeMatchId,
        betClass: 'event',
        player: myName,
        betKey: pending.betKey,
        label: pending.label,
        odds: pending.odds,
        amount: pending.amount,
        status: 'pending',
        scoreAtBet: `${currentMatch.homeScore}:${currentMatch.awayScore}`,
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      };
    } else {
      // recompute shares at confirm time using the freshest pool state, in case someone else
      // bet in the few seconds between opening the confirm modal and tapping confirm
      const freshPoolBets = betsRef.current.filter((b) => b.matchId === activeMatchId && b.betClass === 'pool' && b.poolKey === pending.poolKey && b.status === 'pending');
      const freshStake = freshPoolBets.filter((b) => b.direction === pending.direction).reduce((s, b) => s + b.amount, 0);
      const freshPrice = sharePricePerChip(pending.poolKey, pending.direction, elapsedRatio, freshStake, currentMatch.homeScore, currentMatch.awayScore);
      const shares = sharesForStake(pending.amount, freshPrice);

      bet = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        matchId: activeMatchId,
        betClass: 'pool',
        poolKey: pending.poolKey,
        player: myName,
        direction: pending.direction,
        label: pending.label,
        amount: pending.amount,
        pricePerShare: freshPrice,
        shares,
        status: 'pending',
        scoreAtBet: `${currentMatch.homeScore}:${currentMatch.awayScore}`,
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      };
    }

    const newBets = [bet, ...betsRef.current];
    
    // Step 2: Write bet to DB
    const successBets = await persistBets(sessionCode, newBets);
    if (!successBets) {
      // Rollback: write original chips back to DB & revert local ref
      const rollbackPlayers = { ...newPlayers, [myName]: oldChips };
      await persistPlayers(sessionCode, rollbackPlayers);
      playersRef.current = rollbackPlayers;
      showToast('⚠️ 下注保存失败，已自动退回筹码，请重试');
      return;
    }

    // Success! Update local bets ref
    betsRef.current = newBets;

    if (pending.kind === 'event') {
      showToast(`下注成功：${pending.label} @ ${pending.odds}x`);
      if (typeof pending.betKey === 'string' && pending.betKey.startsWith('custom-')) {
        setCustomEvent('');
        setCustomOdds('2.0');
      }
    } else {
      showToast(`下注成功：${pending.label}，买到 ${bet.shares.toFixed(1)} 份额`);
    }
  };

  // ----- Resolve a single event bet (host action) -----
  const resolveEventBet = async (betId, won) => {
    if (!sessionCode) return;
    const bet = betsRef.current.find((b) => b.id === betId);
    if (!bet || bet.status !== 'pending') return; // guard against double-resolving (rapid double-tap)

    const newBets = betsRef.current.map((b) => (b.id === betId ? { ...b, status: won ? 'won' : 'lost' } : b));
    
    if (won) {
      const payout = Math.round(bet.amount * bet.odds);
      const newPlayers = { ...playersRef.current, [bet.player]: (playersRef.current[bet.player] || 0) + payout };

      // Win resolution: write payout chips to DB first
      const successPlayers = await persistPlayers(sessionCode, newPlayers);
      if (!successPlayers) return; // aborted

      // Then write resolved bet status to DB
      const successBets = await persistBets(sessionCode, newBets);
      if (!successBets) {
        // Rollback: revert player payout chips in DB
        const rollbackPlayers = { ...newPlayers, [bet.player]: (playersRef.current[bet.player] || 0) };
        await persistPlayers(sessionCode, rollbackPlayers);
        return;
      }

      playersRef.current = newPlayers;
      betsRef.current = newBets;
      showToast(`${bet.player} 猜中「${bet.label}」，获得 ${payout} 筹码`);
    } else {
      // Lost bet resolution: no chips awarded, simply update bet status
      const successBets = await persistBets(sessionCode, newBets);
      if (successBets) {
        betsRef.current = newBets;
        showToast(`${bet.player} 的「${bet.label}」未中`);
      }
    }
  };

  // ----- Settle the whole match-result pool at once (host action) -----
  const settleMatchPool = async (poolKey, winningDirection) => {
    if (!sessionCode || !activeMatchId) return;
    const freshPoolBets = betsRef.current.filter((b) => b.matchId === activeMatchId && b.betClass === 'pool' && b.poolKey === poolKey && b.status === 'pending');
    const poolLabel = poolKey === 'final' ? '最终结果' : '常规时间';
    if (freshPoolBets.length === 0) { showToast(`这场比赛还没有人下${poolLabel}注`); return; }

    const { payouts, betPayouts, refunded } = settlePool(freshPoolBets, winningDirection);

    const settledIds = new Set(freshPoolBets.map((b) => b.id));
    const newBets = betsRef.current.map((b) => {
      if (!settledIds.has(b.id)) return b;
      if (refunded) {
        // nobody backed the winning outcome -- everyone gets their stake back, no winners/losers
        return { ...b, status: 'refunded', payout: betPayouts[b.id] ?? b.amount };
      }
      const won = b.direction === winningDirection;
      return { ...b, status: won ? 'won' : 'lost', payout: won ? betPayouts[b.id] ?? 0 : 0 };
    });

    const freshPlayers = { ...playersRef.current };
    Object.entries(payouts).forEach(([player, amount]) => {
      freshPlayers[player] = (freshPlayers[player] || 0) + amount;
    });

    // Write payouts to DB first
    const successPlayers = await persistPlayers(sessionCode, freshPlayers);
    if (!successPlayers) return; // aborted

    // Then write resolved bets to DB
    const successBets = await persistBets(sessionCode, newBets);
    if (!successBets) {
      // Rollback: revert player payouts in DB
      const rollbackPlayers = { ...playersRef.current };
      await persistPlayers(sessionCode, rollbackPlayers);
      return;
    }

    // Success! Commit to refs
    playersRef.current = freshPlayers;
    betsRef.current = newBets;

    const resultLabel = winningDirection === 'home' ? currentMatch.home + '胜' : winningDirection === 'away' ? currentMatch.away + '胜' : '平局';
    if (refunded) {
      showToast(`「${poolLabel}」没有人押中「${resultLabel}」，本金已退还`);
    } else {
      showToast(`「${poolLabel}」结算完成，${Object.keys(payouts).length} 人瓜分奖池`);
    }
  };

  const startMatchClock = async () => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    // frozenElapsedMinutes (0 for a fresh match, or whatever was banked at last pause) becomes
    // the new base; kickoffAt resets to now so computeElapsedMinutes counts forward from there.
    // Also broadcast the pricing bucket immediately rather than waiting for the next 5s tick,
    // so share prices reflect the restart right away for everyone.
    const bucket = bucketPricingMinutes(m.frozenElapsedMinutes || 0);
    const next = { ...matchesRef.current, [activeMatchId]: { ...m, clockStatus: 'running', kickoffAt: Date.now(), broadcastPricingMinutes: bucket } };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    showToast(m.frozenElapsedMinutes > 0 ? '计时已继续' : '比赛开始，计时已启动');
  };

  const pauseMatchClock = async () => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    // freeze elapsed time by converting the running clock into a fixed offset, then stopping
    const frozenMinutes = computeElapsedMinutes(m, Date.now());
    const next = {
      ...matchesRef.current,
      [activeMatchId]: { ...m, clockStatus: 'not_started', kickoffAt: null, frozenElapsedMinutes: frozenMinutes, broadcastPricingMinutes: bucketPricingMinutes(frozenMinutes) },
    };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    showToast('计时已暂停');
  };

  const updateEventOddsOverride = async (eventKey, odds) => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const clampedOdds = Math.max(EVENT_ODDS_MIN, Math.min(EVENT_ODDS_MAX, odds));
    const next = {
      ...matchesRef.current,
      [activeMatchId]: { ...m, eventOddsOverrides: { ...(m.eventOddsOverrides || {}), [eventKey]: clampedOdds } },
    };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    showToast(`已调整赔率为 ${clampedOdds}x`);
  };

  // Host renames a FIXED event's display text (e.g. "下一张黄牌" -> "上半场黄牌"). The underlying
  // eventKey stays the same, so existing pending bets on that event still resolve correctly --
  // only the label shown in the UI changes going forward.
  const updateEventLabelOverride = async (eventKey, label) => {
    if (!activeMatchId || !sessionCode) return;
    const trimmed = label.trim();
    if (!trimmed) { showToast('事件名字不能为空'); return; }
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const next = {
      ...matchesRef.current,
      [activeMatchId]: { ...m, eventLabelOverrides: { ...(m.eventLabelOverrides || {}), [eventKey]: trimmed } },
    };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    showToast(`已改名为「${trimmed}」`);
  };

  // Host adds a brand-new proposition mid-match (e.g. "extra time?", "penalty shootout?").
  // The host sets the odds themselves since there's no natural default for an arbitrary event.
  const [newEventDraft, setNewEventDraft] = useState({ label: '', odds: '2.0' });
  const [editingEventKey, setEditingEventKey] = useState(null); // which event card (fixed or custom) is currently showing its rename input
  const [eventEditDraft, setEventEditDraft] = useState({ label: '', odds: '' });
  const addCustomHostEvent = async () => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const label = newEventDraft.label.trim();
    const odds = Number(newEventDraft.odds);
    if (!label) { showToast('请输入事件描述'); return; }
    if (!odds || odds <= 1) { showToast('赔率需大于1'); return; }
    const key = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = { key, label, odds: +odds.toFixed(2) };
    const next = { ...matchesRef.current, [activeMatchId]: { ...m, customEvents: [...(m.customEvents || []), entry] } };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    setNewEventDraft({ label: '', odds: '2.0' });
    showToast(`已添加事件：${label} @ ${entry.odds}x`);
  };

  const removeCustomHostEvent = async (key) => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const next = { ...matchesRef.current, [activeMatchId]: { ...m, customEvents: (m.customEvents || []).filter((e) => e.key !== key) } };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
  };

  // Host edits an existing custom event's label and/or odds in place (key stays stable so
  // pending bets on it keep resolving correctly).
  const updateCustomHostEvent = async (key, patch) => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const list = m.customEvents || [];
    const idx = list.findIndex((e) => e.key === key);
    if (idx === -1) { showToast('这个事件已经被移除了'); return; }
    const current = list[idx];
    const nextLabel = patch.label != null ? patch.label.trim() : current.label;
    if (!nextLabel) { showToast('事件名字不能为空'); return; }
    let nextOdds = current.odds;
    if (patch.odds != null && patch.odds !== '') {
      const parsed = Number(patch.odds);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        showToast('赔率需要是大于0的数字');
        return;
      }
      nextOdds = Math.max(EVENT_ODDS_MIN, Math.min(EVENT_ODDS_MAX, parsed));
    }
    // blank string: silently keep current.odds (user only meant to change the label)
    const updatedList = [...list];
    updatedList[idx] = { ...current, label: nextLabel, odds: +Number(nextOdds).toFixed(2) };
    const next = { ...matchesRef.current, [activeMatchId]: { ...m, customEvents: updatedList } };
    matchesRef.current = next;
    await persistMatches(sessionCode, next);
    showToast('已更新事件');
  };


  const updateScore = async (side, delta) => {
    if (!activeMatchId || !sessionCode) return;
    const m = matchesRef.current[activeMatchId];
    if (!m) return;
    const next = {
      ...matchesRef.current,
      [activeMatchId]: {
        ...m,
        homeScore: side === 'home' ? Math.max(0, m.homeScore + delta) : m.homeScore,
        awayScore: side === 'away' ? Math.max(0, m.awayScore + delta) : m.awayScore,
      },
    };
    matchesRef.current = next; // update synchronously so back-to-back clicks stack correctly
    await persistMatches(sessionCode, next);
  };

  const saveMatchNames = async () => {
    if (!activeMatchId || !sessionCode) return;
    const m = matches[activeMatchId];
    const next = { ...matches, [activeMatchId]: { ...m, home: matchDraft.home || '主队', away: matchDraft.away || '客队' } };
    await persistMatches(sessionCode, next);
    setEditingMatch(false);
  };

  const createMatch = async () => {
    if (!sessionCode) return;
    const home = newMatchDraft.home.trim() || '主队';
    const away = newMatchDraft.away.trim() || '客队';
    const id = newMatchId();
    const next = { ...matches, [id]: newFreshMatch(home, away, newMatchDraft.mode) };
    const matchesSaved = await persistMatches(sessionCode, next);
    const activeSaved = await persistActiveMatch(sessionCode, id);
    setNewMatchDraft({ home: '', away: '', mode: 'group' });
    setEditingEventKey(null); // avoid carrying a stale rename box over to the new match

    if (!matchesSaved || !activeSaved) {
      // persistMatches/persistActiveMatch already showed an error toast for a thrown exception
      return;
    }

    // window.storage.set() resolving without throwing does NOT guarantee the write actually
    // landed -- some storage backends can resolve successfully while silently failing to persist.
    // Read the data straight back from shared storage (not from local React state, which would
    // trivially match since we just set it) to confirm the write is real before telling the host
    // it's safe to move on.
    try {
      const verifyRead = await window.storage.get(sessionKey(sessionCode, 'matches'), true);
      const verifiedMatches = verifyRead && verifyRead.value ? JSON.parse(verifyRead.value) : null;
      if (!verifiedMatches || !verifiedMatches[id]) {
        showToast('⚠️ 比赛创建后验证失败，数据可能没有真正保存，请重试或刷新后确认');
        return;
      }
    } catch (e) {
      showToast('⚠️ 无法验证比赛是否保存成功，请刷新页面确认');
      return;
    }

    showToast(`已创建：${home} vs ${away}`);
    setScreen('board');
  };

  const endMatch = async (id) => {
    if (!sessionCode) return;
    const m = matches[id];
    if (!m) return;
    const next = { ...matches, [id]: { ...m, status: 'ended' } };
    await persistMatches(sessionCode, next);
    showToast(`已结束：${m.home} vs ${m.away}`);
  };

  const switchMatch = async (id) => {
    if (!sessionCode) return;
    await persistActiveMatch(sessionCode, id);
    setEditingEventKey(null); // don't carry a stale rename box over to the newly-selected match
    setScreen('board');
  };

  if (screen === 'loading') {
    return (
      <div style={styles.loadingWrap}>
        <div style={styles.loadingPulse}>●</div>
      </div>
    );
  }

  if (screen === 'join') {
    return (
      <div style={styles.page}>
        <style>{fontFace}</style>
        <div className="join-card animate-fade-in">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <img src={heroImg} style={{ width: 140, height: 'auto', objectFit: 'contain' }} alt="Hero Logo" />
          </div>
          <div style={{ ...styles.joinEyebrow, letterSpacing: 2, fontSize: 11 }}>世界杯观赛夜 · 实时筹码下注</div>
          <div className="join-title">绿茵筹码风暴</div>
          {storageBroken && (
            <div style={styles.storageWarning}>
              ⚠️ 检测到存储功能异常，数据可能无法保存或同步给其他人。请确认这个 artifact 已经正确 Publish（不是草稿状态），并刷新页面重试。
              {storageDiagnostic && <div style={styles.storageDiagnosticDetail}>诊断详情：{storageDiagnostic}</div>}
            </div>
          )}
          <div style={styles.joinSub}>输入房间码：已存在就加入，不存在就自动创建新房间</div>
          <input
            className="join-input"
            placeholder="房间码，如 PARTY01"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinGame()}
          />
          <input
            className="join-input"
            placeholder="你的名字"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinGame()}
          />
          <div style={{ fontSize: 11, color: '#9FB8AC', marginTop: -6, marginBottom: 12, textAlign: 'left', paddingLeft: 4, lineHeight: 1.4 }}>
            💡 提示：为了避免同名混淆，同一房间的玩家请尽量使用独特且好记的名字（如：小明2026）。
          </div>
          <button className="join-btn" onClick={joinGame}>进场</button>
          <div style={styles.joinHint}>提示：给自己的这盘起个好记的房间码（比如队名缩写+日期），发给朋友，大家填一样的房间码就能进同一盘</div>
        </div>
      </div>
    );
  }

  if (screen === 'bets') {
    return (
      <LiveBetsScreen
        sessionCode={sessionCode}
        bets={bets}
        matches={matches}
        activeMatchId={activeMatchId}
        myName={myName}
        hostName={hostName}
        onSwitchTab={setScreen}
      />
    );
  }

  return (
    <div style={styles.page}>
      <style>{fontFace}</style>
      {toast && <div style={styles.toast}>{toast}</div>}

      <div className="animate-fade-in">

      {/* Room bar */}
      <div style={styles.roomBar}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={styles.roomCodeTag}>房间 {sessionCode}</span>
          <span style={{ fontSize: 10, color: '#9FB8AC', fontWeight: 500 }}>
            👑 主持人: {hostName || '（等待加入）'}
          </span>
        </div>
        <button style={styles.leaveBtn} onClick={() => setShowLeaveConfirm(true)}>切换房间</button>
      </div>

      {/* Welcome banner */}
      {showWelcomeBanner && (
        <div style={styles.welcomeBanner}>
          <div style={styles.welcomeBannerContent}>
            <span>👋 <strong>欢迎回来，{showWelcomeBanner}！</strong> 你的筹码（{players[showWelcomeBanner] || 100}）和历史下注已同步恢复。</span>
            <button style={styles.welcomeBannerClose} onClick={() => setShowWelcomeBanner(null)}>×</button>
          </div>
        </div>
      )}

      {storageBroken && (
        <div style={{ ...styles.storageWarning, margin: '12px 20px 0' }}>
          ⚠️ 存储功能异常，你的操作可能没有真正保存。请刷新页面重试，如果持续出现，请确认这个 artifact 是否已正确 Publish。
          {storageDiagnostic && <div style={styles.storageDiagnosticDetail}>诊断详情：{storageDiagnostic}</div>}
        </div>
      )}

      {!initialLoadDone ? (
        <div style={styles.noMatchState}>
          <div style={styles.loadingPulse}>●</div>
        </div>
      ) : !hasMatch ? (
        <div style={styles.noMatchState}>
          <div style={styles.noMatchIcon}>⚽</div>
          <div style={styles.noMatchTitle}>房间里还没有比赛</div>
          <div style={styles.noMatchSub}>
            {isHost ? '创建第一场比赛，选好小组赛还是淘汰赛模式，就能开始下注了' : '等主持人创建第一场比赛'}
          </div>
          {isHost && (
            <button style={styles.joinBtn} onClick={() => setScreen('matches')}>创建第一场比赛</button>
          )}
        </div>
      ) : (
        <>
      {/* Scoreboard */}
      <div style={styles.scoreboard}>
        <div style={styles.scoreboardTop}>
          <span>
            <span style={styles.liveDot} /> {currentMatch.status === 'live' ? 'LIVE' : '已结束'}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={styles.hostToggle} onClick={() => setScreen('matches')}>比赛管理</button>
            {isHost && <span style={styles.hostBadge}>👑 主持人</span>}
          </div>
        </div>
        <div style={styles.scoreRow}>
          <div style={styles.teamBlock}>
            {editingMatch ? (
              <input
                style={styles.teamNameInput}
                value={matchDraft.home}
                onChange={(e) => setMatchDraft({ ...matchDraft, home: e.target.value })}
              />
            ) : (
              <div style={styles.teamName}>{currentMatch.home}</div>
            )}
            {isHost && !editingMatch && currentMatch.status === 'live' && (
              <div style={styles.scoreBtns}>
                <button style={styles.scoreBtn} onClick={() => updateScore('home', 1)}>+</button>
                <button style={styles.scoreBtn} onClick={() => updateScore('home', -1)}>−</button>
              </div>
            )}
          </div>
          <div style={styles.scoreNums}>
            <span style={styles.bigScore}>{currentMatch.homeScore}</span>
            <span style={styles.scoreColon}>:</span>
            <span style={styles.bigScore}>{currentMatch.awayScore}</span>
          </div>
          <div style={styles.teamBlock}>
            {editingMatch ? (
              <input
                style={styles.teamNameInput}
                value={matchDraft.away}
                onChange={(e) => setMatchDraft({ ...matchDraft, away: e.target.value })}
              />
            ) : (
              <div style={styles.teamName}>{currentMatch.away}</div>
            )}
            {isHost && !editingMatch && currentMatch.status === 'live' && (
              <div style={styles.scoreBtns}>
                <button style={styles.scoreBtn} onClick={() => updateScore('away', 1)}>+</button>
                <button style={styles.scoreBtn} onClick={() => updateScore('away', -1)}>−</button>
              </div>
            )}
          </div>
        </div>
        {isHost && currentMatch.status === 'live' && (
          <div style={styles.editRow}>
            {editingMatch ? (
              <button style={styles.editLink} onClick={saveMatchNames}>保存队名</button>
            ) : (
              <button style={styles.editLink} onClick={() => { setMatchDraft({ home: currentMatch.home, away: currentMatch.away }); setEditingMatch(true); }}>
                编辑队名
              </button>
            )}
          </div>
        )}
      </div>

      {/* Chips bar */}
      <div style={styles.chipsBar}>
        <div>
          <div style={styles.chipsLabel}>{myName} 的总筹码</div>
          <div style={styles.chipsValue}>{myChips}</div>
        </div>
        <button style={styles.leaderboardBtn} onClick={() => setScreen('leaderboard')}>排行榜</button>
      </div>

      {isHost && (pendingEventBets.length > 0 || finalPool.poolBets.length > 0 || regulationPool.poolBets.length > 0) && (
        <a href="#settlement-zone" style={styles.settleAlert}>
          <span>🔔 有 {pendingEventBets.length + (finalPool.poolBets.length > 0 ? 1 : 0) + (regulationPool.poolBets.length > 0 ? 1 : 0)} 项待你结算</span>
          <span style={styles.settleAlertArrow}>↓ 去结算</span>
        </a>
      )}

      {currentMatch.status !== 'live' ? (
        <div style={styles.endedNotice}>
          这场比赛已结束，去「比赛管理」切换到其他比赛或创建新比赛
        </div>
      ) : (
        <>
          <div style={styles.clockRow}>
            <span style={styles.clockLabel}>
              <span style={styles.liveDot} />
              {currentMatch.clockStatus === 'running' ? `${Math.floor(liveElapsedMinutes)}'` : currentMatch.frozenElapsedMinutes > 0 ? `暂停于 ${Math.floor(currentMatch.frozenElapsedMinutes)}'` : '未开始'}
            </span>
            {isHost && (
              currentMatch.clockStatus === 'running'
                ? <button style={styles.clockBtn} onClick={pauseMatchClock}>暂停</button>
                : <button style={styles.clockBtnStart} onClick={startMatchClock}>{currentMatch.frozenElapsedMinutes > 0 ? '继续比赛' : '开始比赛'}</button>
            )}
          </div>

          {/* Wager input */}
          <div style={styles.wagerRow}>
            <span style={styles.wagerLabel}>下注筹码</span>
            <input
              type="number"
              style={styles.wagerInput}
              value={wager}
              min={1}
              step={1}
              onChange={(e) => setWager(e.target.value)}
            />
            {[5, 10, 20, 50].map((v) => (
              <button key={v} style={styles.chipQuick} onClick={() => setWager(v)}>{v}</button>
            ))}
          </div>

          {isKnockout && (
            <>
              {/* Pool 1: final result (win/lose only, no draw) */}
              <div style={styles.sectionLabel}><span style={styles.sectionDot} />池子① 谁最终晋级（不含常规时间平局）</div>
              <div style={styles.poolInfoRow}>奖池共 {finalPool.totalChips} 筹码 · 猜中方按份额瓜分全部输家筹码</div>
              <div style={styles.matchBetRow}>
                <button style={styles.matchBetBtn} onClick={() => requestPoolBet('final', 'home', `${currentMatch.home}晋级`)}>
                  <div style={styles.matchBetLabel}>{currentMatch.home}晋级</div>
                  <div style={styles.matchBetPrice}>{finalPool.sharePrices.home.toFixed(2)}<span style={styles.priceUnit}>/份</span></div>
                </button>
                <button style={styles.matchBetBtn} onClick={() => requestPoolBet('final', 'away', `${currentMatch.away}晋级`)}>
                  <div style={styles.matchBetLabel}>{currentMatch.away}晋级</div>
                  <div style={styles.matchBetPrice}>{finalPool.sharePrices.away.toFixed(2)}<span style={styles.priceUnit}>/份</span></div>
                </button>
              </div>
              {isHost && finalPool.poolBets.length > 0 && (
                <div id="settlement-zone" style={styles.settlePoolRow}>
                  <span style={styles.settlePoolLabel}>比赛彻底结束后选择最终晋级方结算：</span>
                  <div style={styles.settlePoolBtns}>
                    <button style={styles.settlePoolBtn} onClick={() => settleMatchPool('final', 'home')}>{currentMatch.home}晋级</button>
                    <button style={styles.settlePoolBtn} onClick={() => settleMatchPool('final', 'away')}>{currentMatch.away}晋级</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Pool 2 (or the only pool in group-stage mode): regulation-time result */}
          <div style={styles.sectionLabel}><span style={styles.sectionDot} />{isKnockout ? '池子② 90分钟常规时间比分（含平局）' : '胜平负资金池 · 90分钟比赛结果'}</div>
          <div style={styles.poolInfoRow}>奖池共 {regulationPool.totalChips} 筹码 · 越晚下注单价越贵，猜中方按份额瓜分全部输家筹码</div>
          <div style={styles.matchBetRow}>
            <button style={styles.matchBetBtn} onClick={() => requestPoolBet('regulation', 'home', `${currentMatch.home}胜`)}>
              <div style={styles.matchBetLabel}>{currentMatch.home}胜</div>
              <div style={styles.matchBetPrice}>{regulationPool.sharePrices.home.toFixed(2)}<span style={styles.priceUnit}>/份</span></div>
            </button>
            <button style={styles.matchBetBtn} onClick={() => requestPoolBet('regulation', 'draw', '平局')}>
              <div style={styles.matchBetLabel}>平局</div>
              <div style={styles.matchBetPrice}>{regulationPool.sharePrices.draw.toFixed(2)}<span style={styles.priceUnit}>/份</span></div>
            </button>
            <button style={styles.matchBetBtn} onClick={() => requestPoolBet('regulation', 'away', `${currentMatch.away}胜`)}>
              <div style={styles.matchBetLabel}>{currentMatch.away}胜</div>
              <div style={styles.matchBetPrice}>{regulationPool.sharePrices.away.toFixed(2)}<span style={styles.priceUnit}>/份</span></div>
            </button>
          </div>
          {isHost && regulationPool.poolBets.length > 0 && (
            <div id={!isKnockout ? 'settlement-zone' : undefined} style={styles.settlePoolRow}>
              <span style={styles.settlePoolLabel}>90分钟结束后选择常规时间结果结算：</span>
              <div style={styles.settlePoolBtns}>
                <button style={styles.settlePoolBtn} onClick={() => settleMatchPool('regulation', 'home')}>{currentMatch.home}胜</button>
                <button style={styles.settlePoolBtn} onClick={() => settleMatchPool('regulation', 'draw')}>平局</button>
                <button style={styles.settlePoolBtn} onClick={() => settleMatchPool('regulation', 'away')}>{currentMatch.away}胜</button>
              </div>
            </div>
          )}
          <div style={styles.oddsDisclaimer}>价格是买1份额需要的筹码数，不是保证赔率；实际收益取决于结算时奖池怎么分</div>

          {/* Event bets */}
          <div style={styles.sectionLabel}><span style={styles.sectionDot} />临场事件 · 系统按赔率直接发筹码</div>
          <div style={styles.eventGrid}>
            {buildFixedEvents(currentMatch.home, currentMatch.away, currentMatch.matchMode).map((ev) => {
              const displayLabel = (currentMatch.eventLabelOverrides || {})[ev.key] || ev.label;
              const odds = eventOdds(ev.key, currentMatch.homeScore, currentMatch.awayScore, currentMatch.eventOddsOverrides);
              const isEditing = editingEventKey === ev.key;
              return (
                <div key={ev.key} style={styles.eventBtnWrap}>
                  {isEditing ? (
                    <div style={styles.eventEditBox}>
                      <input
                        style={styles.eventEditInput}
                        value={eventEditDraft.label}
                        onChange={(e) => setEventEditDraft({ ...eventEditDraft, label: e.target.value })}
                        placeholder="事件名字"
                      />
                      <div style={styles.eventEditBtnRow}>
                        <button
                          style={styles.eventEditSaveBtn}
                          onClick={() => { updateEventLabelOverride(ev.key, eventEditDraft.label); setEditingEventKey(null); }}
                        >
                          保存
                        </button>
                        <button style={styles.eventEditCancelBtn} onClick={() => setEditingEventKey(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <button style={styles.eventBtn} onClick={() => requestEventBet(ev.key, displayLabel, odds)}>
                      <span>{displayLabel}</span>
                      <span style={styles.eventOdds}>{odds}x</span>
                    </button>
                  )}
                  {isHost && !isEditing && (
                    <div style={styles.eventOddsEditRow}>
                      <button style={styles.oddsAdjustBtn} onClick={() => updateEventOddsOverride(ev.key, odds - 0.1)}>−</button>
                      <button
                        style={styles.renameBtn}
                        onClick={() => { setEditingEventKey(ev.key); setEventEditDraft({ label: displayLabel, odds: String(odds) }); }}
                      >
                        改名
                      </button>
                      <button style={styles.oddsAdjustBtn} onClick={() => updateEventOddsOverride(ev.key, odds + 0.1)}>+</button>
                    </div>
                  )}
                </div>
              );
            })}
            {(currentMatch.customEvents || []).map((ev) => {
              const isEditing = editingEventKey === ev.key;
              return (
                <div key={ev.key} style={styles.eventBtnWrap}>
                  {isEditing ? (
                    <div style={styles.eventEditBox}>
                      <input
                        style={styles.eventEditInput}
                        value={eventEditDraft.label}
                        onChange={(e) => setEventEditDraft({ ...eventEditDraft, label: e.target.value })}
                        placeholder="事件名字"
                      />
                      <input
                        style={styles.eventEditOddsInput}
                        type="number"
                        step="0.1"
                        value={eventEditDraft.odds}
                        onChange={(e) => setEventEditDraft({ ...eventEditDraft, odds: e.target.value })}
                        placeholder="赔率"
                      />
                      <div style={styles.eventEditBtnRow}>
                        <button
                          style={styles.eventEditSaveBtn}
                          onClick={() => {
                            updateCustomHostEvent(ev.key, { label: eventEditDraft.label, odds: eventEditDraft.odds });
                            setEditingEventKey(null);
                          }}
                        >
                          保存
                        </button>
                        <button style={styles.eventEditCancelBtn} onClick={() => setEditingEventKey(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <button style={styles.eventBtn} onClick={() => requestEventBet(ev.key, ev.label, ev.odds)}>
                      <span>{ev.label}</span>
                      <span style={styles.eventOdds}>{ev.odds}x</span>
                    </button>
                  )}
                  {isHost && !isEditing && (
                    <div style={styles.eventOddsEditRow}>
                      <span style={styles.oddsAdjustLabel}>主持人添加</span>
                      <button
                        style={styles.renameBtn}
                        onClick={() => { setEditingEventKey(ev.key); setEventEditDraft({ label: ev.label, odds: String(ev.odds) }); }}
                      >
                        编辑
                      </button>
                      <button style={styles.removeEventBtn} onClick={() => removeCustomHostEvent(ev.key)}>移除</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isHost && (
            <>
              <div style={styles.sectionLabel}><span style={styles.sectionDot} />主持人：临场新增一个事件（自己定赔率）</div>
              <div style={styles.customRow}>
                <input
                  style={styles.customInput}
                  placeholder="比如：是否有加时赛、是否点球大战"
                  value={newEventDraft.label}
                  onChange={(e) => setNewEventDraft({ ...newEventDraft, label: e.target.value })}
                />
                <input
                  style={styles.customOddsInput}
                  type="number"
                  step="0.1"
                  value={newEventDraft.odds}
                  onChange={(e) => setNewEventDraft({ ...newEventDraft, odds: e.target.value })}
                />
                <button style={styles.customBtn} onClick={addCustomHostEvent}>添加</button>
              </div>
            </>
          )}

          {/* Custom bet (players propose their own prop bet on the spot) */}
          <div style={styles.sectionLabel}><span style={styles.sectionDot} />玩家提议事件 · 自己定赔率，系统按赔率发筹码</div>
          <div style={styles.customRow}>
            <input
              style={styles.customInput}
              placeholder="比如：下一次角球在10分钟内"
              value={customEvent}
              onChange={(e) => setCustomEvent(e.target.value)}
            />
            <input
              style={styles.customOddsInput}
              type="number"
              step="0.1"
              value={customOdds}
              onChange={(e) => setCustomOdds(e.target.value)}
            />
            <button style={styles.customBtn} onClick={placeCustomBet}>下注</button>
          </div>
        </>
      )}



      {/* Host: resolve pending event bets (pool bets are settled together via settleMatchPool above) */}
      {isHost && pendingEventBets.length > 0 && (
        <>
          <div id={finalPool.poolBets.length === 0 && regulationPool.poolBets.length === 0 ? 'settlement-zone' : undefined} style={styles.sectionLabel}>临场事件待结算（主持人操作）</div>
          <div style={styles.pendingList}>
            {pendingEventBets.map((b) => (
              <div key={b.id} style={styles.pendingItem}>
                <div>
                  <div style={styles.pendingLabel}>{b.player} · {b.label}</div>
                  <div style={styles.pendingMeta}>{b.amount} 筹码 @ {b.odds}x · 下注时比分 {b.scoreAtBet}</div>
                </div>
                <div style={styles.pendingActions}>
                  <button style={styles.winBtn} onClick={() => resolveEventBet(b.id, true)}>猜中</button>
                  <button style={styles.loseBtn} onClick={() => resolveEventBet(b.id, false)}>未中</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={styles.viewBetsPrompt} onClick={() => setScreen('bets')}>
        查看本场所有人的下注情况 →
      </div>
        </>
      )}

      <TabBar active="board" onSwitch={setScreen} />
    </div>

    {pendingBetConfirm && (
      <BetConfirmModal
        pending={pendingBetConfirm}
        myChips={myChips}
        onCancel={cancelBetConfirm}
        onConfirm={confirmBet}
      />
    )}

    {screen === 'leaderboard' && (
        <div style={styles.modalOverlay} onClick={() => setScreen('board')} className="mobile-bottom-sheet-overlay">
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()} className="mobile-bottom-sheet-card">
            <div className="sheet-handle-wrap" style={styles.sheetHandle} />
            <div style={styles.modalTitle}>房间「{sessionCode}」总筹码排行榜</div>
            {leaderboard.map(([n, chips], i) => (
              <div key={n} style={styles.rankRow}>
                <span style={styles.rankNum}>{i + 1}</span>
                <span style={styles.rankName}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ fontWeight: 500 }}>{n}{n === myName ? ' (我)' : ''}</span>
                    {n === hostName && (
                      <span style={styles.rankHostTag}>👑 主持人</span>
                    )}
                    {playerTitles[n] && (
                      <span style={{ ...styles.rankTitleTag, border: '1px solid rgba(242, 169, 59, 0.3)', borderRadius: 6, padding: '1px 5px', background: 'rgba(242, 169, 59, 0.04)', display: 'inline-flex', alignItems: 'center', lineHeight: 1.2 }}>
                        {playerTitles[n].emoji} {playerTitles[n].label}
                      </span>
                    )}
                  </div>
                </span>
                <span style={styles.rankChips}>{chips}</span>
              </div>
            ))}
            <button style={{ ...styles.joinBtn, marginTop: 14 }} onClick={() => setScreen('recap')}>生成战报卡片</button>
            <button style={styles.closeModalBtn} onClick={() => setScreen('board')}>关闭</button>
          </div>
        </div>
      )}

      {screen === 'recap' && (
        <RecapCard
          sessionCode={sessionCode}
          leaderboard={leaderboard}
          playerTitles={playerTitles}
          playerStats={playerStats}
          bets={bets}
          matches={matches}
          myName={myName}
          onClose={() => setScreen('leaderboard')}
        />
      )}

      {screen === 'matches' && (
        <div style={styles.modalOverlay} onClick={() => setScreen('board')} className="mobile-bottom-sheet-overlay">
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()} className="mobile-bottom-sheet-card">
            <div className="sheet-handle-wrap" style={styles.sheetHandle} />
            <div style={styles.modalTitle}>比赛管理 · 房间「{sessionCode}」</div>
             <div style={styles.matchListWrap}>
              {matchList.map(([id, m]) => {
                const isActive = id === activeMatchId;
                return (
                  <div
                    key={id}
                    onClick={() => !isActive && switchMatch(id)}
                    style={{
                      ...styles.matchListItem,
                      borderColor: isActive ? '#F2A93B' : '#2A5744',
                      background: isActive ? 'rgba(242, 169, 59, 0.08)' : 'rgba(15, 69, 54, 0.25)',
                      cursor: isActive ? 'default' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div style={{ flex: 1, textAlign: 'left' }}>
                      <div style={styles.matchListTeams}>
                        {m.home} {m.homeScore} : {m.awayScore} {m.away}
                        {isActive && (
                          <span style={{ fontSize: 9, color: '#F2A93B', border: '1px solid #F2A93B', borderRadius: 4, padding: '1px 4px', marginLeft: 8, verticalAlign: 'middle', fontWeight: 700 }}>
                            当前选中
                          </span>
                        )}
                      </div>
                      <div style={{ ...styles.matchListStatus, color: m.status === 'live' ? '#86EFAC' : '#9FB8AC', marginTop: 4 }}>
                        {m.status === 'live' ? '🟢 进行中' : '⚪ 已结束'}
                      </div>
                    </div>
                    {m.status === 'live' && isHost && (
                      <button
                        style={{ ...styles.smallBtnEnd, marginLeft: 10 }}
                        onClick={(e) => {
                          e.stopPropagation(); // Avoid triggering switchMatch when ending the match
                          endMatch(id);
                        }}
                      >
                        结束
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ ...styles.sectionLabel, paddingLeft: 0, paddingRight: 0, paddingTop: 20, paddingBottom: 8 }}>新建比赛</div>
            <div style={{ ...styles.customRow, paddingLeft: 0, paddingRight: 0, justifyContent: 'center' }}>
              <input
                style={{ ...styles.customInput, textAlign: 'center' }}
                placeholder="队伍1"
                value={newMatchDraft.home}
                onChange={(e) => setNewMatchDraft({ ...newMatchDraft, home: e.target.value })}
              />
              <input
                style={{ ...styles.customInput, textAlign: 'center' }}
                placeholder="队伍2"
                value={newMatchDraft.away}
                onChange={(e) => setNewMatchDraft({ ...newMatchDraft, away: e.target.value })}
              />
            </div>
            <div style={styles.modeRow}>
              <button
                style={{ ...styles.modeBtn, ...(newMatchDraft.mode === 'group' ? styles.modeBtnActive : {}) }}
                onClick={() => setNewMatchDraft({ ...newMatchDraft, mode: 'group' })}
              >
                小组赛（可以有平局）
              </button>
              <button
                style={{ ...styles.modeBtn, ...(newMatchDraft.mode === 'knockout' ? styles.modeBtnActive : {}) }}
                onClick={() => setNewMatchDraft({ ...newMatchDraft, mode: 'knockout' })}
              >
                淘汰赛（必须分胜负）
              </button>
            </div>
            <button style={{ ...styles.joinBtn, marginTop: 10 }} onClick={createMatch}>创建并切换</button>
            <button style={styles.closeModalBtn} onClick={() => setScreen('board')}>关闭</button>
          </div>
        </div>
      )}

      {showLeaveConfirm && (
        <div style={styles.modalOverlay} onClick={() => setShowLeaveConfirm(false)} className="mobile-bottom-sheet-overlay">
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()} className="mobile-bottom-sheet-card">
            <div className="sheet-handle-wrap" style={styles.sheetHandle} />
            <div style={styles.modalTitle}>切换房间</div>
            <div style={{ color: '#9FB8AC', fontSize: 13, marginBottom: 20, lineHeight: 1.5, textAlign: 'center' }}>
              确定要离开当前房间吗？你的积分和下注历史会被保留，但你需要重新输入房间码才能进入。
            </div>
            <button style={{ ...styles.joinBtn, background: '#E14B3D', color: '#F5F5F0', boxShadow: '0 4px 14px rgba(225, 75, 61, 0.3)', marginBottom: 10 }} onClick={() => {
              setShowLeaveConfirm(false);
              leaveRoom();
            }}>
              确定离开
            </button>
            <button style={styles.closeModalBtn} onClick={() => setShowLeaveConfirm(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const fontFace = `
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap');

  /* Global box-sizing reset for mobile layout safety */
  * {
    box-sizing: border-box;
  }

  /* Premium scrollbar for scrollable panels */
  ::-webkit-scrollbar {
    width: 6px;
  }
  ::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.1);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(242, 169, 59, 0.25);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(242, 169, 59, 0.4);
  }

  /* Fade-in and Slide-up transitions */
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes slideUpSheet {
    from {
      transform: translateY(30px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  .animate-fade-in {
    animation: fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  /* Responsive bottom sheets on mobile devices */
  @media (max-width: 768px) {
    .mobile-bottom-sheet-overlay {
      align-items: flex-end !important;
      padding: 12px !important;
      background: rgba(5, 12, 10, 0.8) !important;
    }
    .mobile-bottom-sheet-card {
      max-width: 100% !important;
      width: 100% !important;
      margin: 0 auto calc(8px + env(safe-area-inset-bottom, 12px)) !important;
      border-radius: 20px !important;
      padding: 18px 20px calc(20px + env(safe-area-inset-bottom, 16px)) !important;
      animation: slideUpSheet 0.35s cubic-bezier(0.15, 0.85, 0.35, 1) forwards;
      max-height: 85vh !important;
      overflow-y: auto !important;
      border: 1px solid rgba(242, 169, 59, 0.25) !important;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6) !important;
    }
  }
  @media (min-width: 769px) {
    .sheet-handle-wrap {
      display: none !important;
    }
  }

  /* Title Gradient */
  .join-title {
    font-family: 'Oswald', sans-serif;
    font-size: 26px;
    font-weight: 700;
    margin-bottom: 12px;
    line-height: 1.3;
    padding-bottom: 6px; /* 防止渐变字下沿被剪切 */
    background: linear-gradient(135deg, #FFD175 0%, #F2A93B 50%, #C97E25 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 4px 10px rgba(242, 169, 59, 0.15);
    letter-spacing: 1px;
  }

  /* Glassmorphism card animation with mobile responsiveness */
  .join-card {
    width: calc(100% - 32px);
    max-width: 380px;
    margin: 8vh auto 0;
    padding: 40px 24px;
    text-align: center;
    background: rgba(15, 69, 54, 0.45);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 24px;
    border: 1px solid rgba(242, 169, 59, 0.15);
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    transition: transform 0.4s cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 0.4s ease;
  }
  .join-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 32px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.15), 0 0 20px rgba(242, 169, 59, 0.05);
  }

  /* Premium inputs with focus glows */
  .join-input {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 16px;
    font-size: 15px;
    border-radius: 12px;
    border: 1.5px solid rgba(42, 87, 68, 0.8);
    background: rgba(10, 40, 31, 0.7);
    color: #F5F5F0;
    margin-bottom: 14px;
    outline: none;
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  }
  .join-input:hover {
    border-color: rgba(242, 169, 59, 0.4);
    background: rgba(10, 40, 31, 0.9);
  }
  .join-input:focus {
    border-color: #F2A93B;
    background: #0A281F;
    box-shadow: 0 0 0 3px rgba(242, 169, 59, 0.25);
  }
  .join-input::placeholder {
    color: rgba(159, 184, 172, 0.55);
  }

  /* Entering button style */
  .join-btn {
    width: 100%;
    padding: 15px 16px;
    font-size: 16px;
    font-weight: 700;
    font-family: 'Oswald', sans-serif;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    border-radius: 12px;
    border: none;
    background: linear-gradient(135deg, #FFD175 0%, #F2A93B 100%);
    color: #0A281F;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(242, 169, 59, 0.3);
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    position: relative;
    overflow: hidden;
  }
  .join-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(242, 169, 59, 0.45);
    background: linear-gradient(135deg, #FFE094 0%, #F4B654 100%);
  }
  .join-btn:active {
    transform: translateY(1px);
    box-shadow: 0 2px 8px rgba(242, 169, 59, 0.2);
  }
`;

function TabBar({ active, onSwitch }) {
  const tabs = [
    { key: 'board', icon: '⚽', label: '比赛' },
    { key: 'bets', icon: '📋', label: '下注情况' },
    { key: 'leaderboard', icon: '🏆', label: '排行榜' },
  ];
  return (
    <div style={styles.tabBar}>
      {tabs.map((t) => (
        <button
          key={t.key}
          style={{ ...styles.tabBarBtn, color: active === t.key ? '#F2A93B' : '#7B93B0' }}
          onClick={() => onSwitch(t.key)}
        >
          <span style={styles.tabBarIcon}>{t.icon}</span>
          <span style={styles.tabBarLabel}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function LiveBetsScreen({ sessionCode, bets, matches, activeMatchId, myName, hostName, onSwitchTab }) {
  const [filter, setFilter] = useState('current'); // 'current' | 'all'
  const relevantBets = filter === 'current' ? bets.filter((b) => b.matchId === activeMatchId) : bets;
  const sorted = [...relevantBets].sort((a, b) => {
    // pending first, then by time descending within each group (most recent activity on top)
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return (b.id || '').localeCompare(a.id || '');
  });

  const currentMatch = matches[activeMatchId];

  const statusLabel = (b) => {
    if (b.status === 'pending') return { text: '待结算', color: '#7B93B0' };
    if (b.status === 'refunded') return { text: `已退还 ${Math.round(b.payout || b.amount)}`, color: '#7B93B0' };
    if (b.status === 'won') {
      const payout = b.betClass === 'pool' ? (b.payout || 0) : b.amount * (b.odds || 0);
      return { text: `赢 ${Math.round(payout)}`, color: '#F2A93B' };
    }
    return { text: '未中', color: '#E14B3D' };
  };

  const poolLabel = (poolKey) => (poolKey === 'final' ? '最终结果' : poolKey === 'regulation' ? '常规时间' : '');

  return (
    <div style={styles.page}>
      <style>{fontFace}</style>
      <div className="animate-fade-in">
        <div style={styles.roomBar}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={styles.roomCodeTag}>房间 {sessionCode} · 下注情况</span>
          <span style={{ fontSize: 10, color: '#9FB8AC', fontWeight: 500 }}>
            👑 主持人: {hostName || '（等待加入）'}
          </span>
        </div>
      </div>

      <div style={styles.betsFilterRow}>
        <button
          style={{ ...styles.betsFilterBtn, ...(filter === 'current' ? styles.betsFilterBtnActive : {}) }}
          onClick={() => setFilter('current')}
        >
          {currentMatch ? `${currentMatch.home} vs ${currentMatch.away}` : '当前比赛'}
        </button>
        <button
          style={{ ...styles.betsFilterBtn, ...(filter === 'all' ? styles.betsFilterBtnActive : {}) }}
          onClick={() => setFilter('all')}
        >
          全部比赛
        </button>
      </div>

      <div style={styles.betsFeedList}>
        {sorted.length === 0 && <div style={styles.emptyState}>还没有人下注</div>}
        {sorted.map((b) => {
          const status = statusLabel(b);
          const m = matches[b.matchId];
          return (
            <div key={b.id} style={styles.betsFeedItem}>
              <div style={styles.betsFeedTop}>
                <span style={styles.betsFeedPlayer}>{b.player}{b.player === myName ? ' (我)' : ''}</span>
                <span style={{ ...styles.betsFeedStatus, color: status.color }}>{status.text}</span>
              </div>
              <div style={styles.betsFeedLabel}>{b.label}</div>
              <div style={styles.betsFeedMeta}>
                {b.betClass === 'pool'
                  ? `${poolLabel(b.poolKey)} · ${b.amount} 筹码 · ${(b.shares || 0).toFixed(1)} 份额`
                  : `${b.amount} 筹码 @ ${b.odds}x`}
                {filter === 'all' && m ? ` · ${m.home} vs ${m.away}` : ''}
                {' · '}{b.time}
              </div>
            </div>
          );
        })}
      </div>

        <TabBar active="bets" onSwitch={onSwitchTab} />
      </div>
    </div>
  );
}

function BetConfirmModal({ pending, myChips, onCancel, onConfirm }) {
  const { kind, label, amount } = pending;
  const remaining = myChips - amount;

  if (kind === 'pool') {
    const { pricePerShare, shares, poolKey } = pending;
    const poolLabel = poolKey === 'final' ? '最终结果' : '常规时间';
    return (
      <div style={confirmStyles.overlay} onClick={onCancel}>
        <style>{fontFace}</style>
        <div style={confirmStyles.whistleBar} />
        <div style={confirmStyles.card} onClick={(e) => e.stopPropagation()}>
          <div style={confirmStyles.cardTopStripe} />
          <div style={confirmStyles.eyebrow}>确认下注 · {poolLabel}资金池</div>
          <div style={confirmStyles.betLabel}>{label}</div>

          <div style={confirmStyles.oddsRow}>
            <span style={confirmStyles.oddsBig}>{shares.toFixed(1)}</span>
            <span style={confirmStyles.oddsBigX}>份</span>
          </div>

          <div style={confirmStyles.detailGrid}>
            <div style={confirmStyles.detailBox}>
              <div style={confirmStyles.detailLabel}>下注</div>
              <div style={confirmStyles.detailValue}>{amount}</div>
            </div>
            <div style={confirmStyles.detailArrow}>→</div>
            <div style={confirmStyles.detailBox}>
              <div style={confirmStyles.detailLabel}>当前单价</div>
              <div style={{ ...confirmStyles.detailValue, color: '#F2A93B' }}>{pricePerShare.toFixed(2)}</div>
            </div>
          </div>

          <div style={confirmStyles.footRow}>
            <span>猜中后按份额瓜分奖池</span>
            <span>下注后剩余 {remaining}</span>
          </div>
          <div style={confirmStyles.poolNote}>这是资金池玩法：赢的一方拿回本金，再按份额比例瓜分所有输家的筹码。如果没人押中最终结果，本金会原样退还给所有人。</div>

          <div style={confirmStyles.btnRow}>
            <button style={confirmStyles.cancelBtn} onClick={onCancel}>取消</button>
            <button style={confirmStyles.confirmBtn} onClick={onConfirm}>确认下注</button>
          </div>
        </div>
      </div>
    );
  }

  const { odds } = pending;
  const payout = Math.round(amount * odds);
  const profit = payout - amount;

  return (
    <div style={confirmStyles.overlay} onClick={onCancel}>
      <style>{fontFace}</style>
      <div style={confirmStyles.whistleBar} />
      <div style={confirmStyles.card} onClick={(e) => e.stopPropagation()}>
        <div style={confirmStyles.cardTopStripe} />
        <div style={confirmStyles.eyebrow}>确认下注</div>
        <div style={confirmStyles.betLabel}>{label}</div>

        <div style={confirmStyles.oddsRow}>
          <span style={confirmStyles.oddsBig}>{odds}</span>
          <span style={confirmStyles.oddsBigX}>x</span>
        </div>

        <div style={confirmStyles.detailGrid}>
          <div style={confirmStyles.detailBox}>
            <div style={confirmStyles.detailLabel}>下注</div>
            <div style={confirmStyles.detailValue}>{amount}</div>
          </div>
          <div style={confirmStyles.detailArrow}>→</div>
          <div style={confirmStyles.detailBox}>
            <div style={confirmStyles.detailLabel}>猜中可得</div>
            <div style={{ ...confirmStyles.detailValue, color: '#F2A93B' }}>{payout}</div>
          </div>
        </div>

        <div style={confirmStyles.footRow}>
          <span>净赢 +{profit}</span>
          <span>下注后剩余 {remaining}</span>
        </div>

        <div style={confirmStyles.btnRow}>
          <button style={confirmStyles.cancelBtn} onClick={onCancel}>取消</button>
          <button style={confirmStyles.confirmBtn} onClick={onConfirm}>确认下注</button>
        </div>
      </div>
    </div>
  );
}

function RecapCard({ sessionCode, leaderboard, playerTitles, playerStats, bets, matches, myName, onClose }) {
  // find the single most dramatic moment: the won bet with the highest profit relative to its stake
  let dramaticBet = null;
  let dramaticMultiple = 0;
  bets.forEach((b) => {
    if (b.status !== 'won') return;
    const payout = b.betClass === 'pool' ? (b.payout || 0) : b.amount * (b.odds || 0);
    const multiple = b.amount > 0 ? payout / b.amount : 0;
    if (!dramaticBet || multiple > dramaticMultiple) {
      dramaticBet = b;
      dramaticMultiple = multiple;
    }
  });

  const totalBets = bets.length;
  const totalMatches = Object.keys(matches).length;
  const champion = leaderboard[0];

  return (
    <div style={recapStyles.overlay}>
      <style>{fontFace}</style>
      <div style={recapStyles.card}>
        <button style={recapStyles.closeBtn} onClick={onClose}>×</button>
        <div style={recapStyles.eyebrow}>世界杯观赛夜 · 战报</div>
        <div style={recapStyles.roomTag}>房间 {sessionCode}</div>

        {champion && (
          <div style={recapStyles.championBlock}>
            <div style={recapStyles.championEmoji}>🏆</div>
            <div style={recapStyles.championName}>{champion[0]}</div>
            <div style={recapStyles.championSub}>本场冠军 · {champion[1]} 筹码</div>
          </div>
        )}

        <div style={recapStyles.statsRow}>
          <div style={recapStyles.statBox}>
            <div style={recapStyles.statNum}>{totalMatches}</div>
            <div style={recapStyles.statLabel}>场比赛</div>
          </div>
          <div style={recapStyles.statBox}>
            <div style={recapStyles.statNum}>{totalBets}</div>
            <div style={recapStyles.statLabel}>笔下注</div>
          </div>
          <div style={recapStyles.statBox}>
            <div style={recapStyles.statNum}>{leaderboard.length}</div>
            <div style={recapStyles.statLabel}>位玩家</div>
          </div>
        </div>

        {dramaticBet && (
          <div style={recapStyles.dramaticBlock}>
            <div style={recapStyles.dramaticLabel}>本场最刺激一注</div>
            <div style={recapStyles.dramaticText}>
              {dramaticBet.betClass === 'pool'
                ? `${dramaticBet.player} 押中「${dramaticBet.label}」，本金翻了 ${dramaticMultiple.toFixed(1)} 倍`
                : `${dramaticBet.player} 以 ${dramaticBet.odds}x 赔率猜中「${dramaticBet.label}」`}
            </div>
            <div style={recapStyles.dramaticPayout}>
              赢得 {Math.round(dramaticBet.betClass === 'pool' ? (dramaticBet.payout || 0) : dramaticBet.amount * dramaticBet.odds)} 筹码
            </div>
          </div>
        )}

        <div style={recapStyles.titleSection}>
          <div style={recapStyles.titleSectionLabel}>本场称号</div>
          {Object.entries(playerTitles).length === 0 && (
            <div style={recapStyles.noTitles}>下注还不够多，称号还没解锁</div>
          )}
          {Object.entries(playerTitles).map(([n, t]) => (
            <div key={n} style={recapStyles.titleRow}>
              <span style={recapStyles.titleEmoji}>{t.emoji}</span>
              <span style={recapStyles.titleName}>{n}</span>
              <span style={recapStyles.titleLabel}>{t.label}</span>
            </div>
          ))}
        </div>

        <div style={recapStyles.historySection}>
          <div style={recapStyles.titleSectionLabel}>我的下注历史</div>
          {bets.filter((b) => b.player === myName).length === 0 ? (
            <div style={recapStyles.noTitles}>你本场还没有下过注</div>
          ) : (
            <div style={recapStyles.historyList}>
              {bets
                .filter((b) => b.player === myName)
                .map((b) => {
                  const payoutText = b.status === 'won'
                    ? `赢 ${Math.round(b.betClass === 'pool' ? (b.payout || 0) : b.amount * (b.odds || 0))}`
                    : b.status === 'refunded'
                    ? '已退还'
                    : b.status === 'lost'
                    ? '未中'
                    : '待结算';
                  const payoutColor = b.status === 'won' ? '#F2A93B' : b.status === 'lost' ? '#E14B3D' : '#7B93B0';

                  return (
                    <div key={b.id} style={recapStyles.historyRow}>
                      <div style={recapStyles.historyLeft}>
                        <span style={recapStyles.historyLabel}>押「{b.label}」</span>
                      </div>
                      <div style={recapStyles.historyRight}>
                        <span style={recapStyles.historyAmount}>{b.amount} 筹码</span>
                        <span style={{ ...recapStyles.historyStatus, color: payoutColor }}>{payoutText}</span>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        <div style={recapStyles.footer}>世界杯观赛夜实时下注 · 纯积分玩具，不涉及真钱</div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: `
      repeating-linear-gradient(
        100deg,
        rgba(255,255,255,0.025) 0px,
        rgba(255,255,255,0.025) 60px,
        transparent 60px,
        transparent 120px
      ),
      radial-gradient(circle at 50% -10%, #12523F 0%, #0B3D2E 55%, #082B20 100%)
    `,
    fontFamily: "'Noto Sans SC', sans-serif",
    color: '#F5F5F0',
    paddingBottom: 40,
  },
  loadingWrap: {
    minHeight: '100vh',
    background: '#0B3D2E',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPulse: {
    color: '#F2A93B',
    fontSize: 24,
  },
  joinCard: {
    maxWidth: 380,
    margin: '10vh auto 0',
    padding: '36px 24px',
    textAlign: 'center',
  },
  joinBadge: {
    width: 56,
    height: 56,
    margin: '0 auto 16px',
    borderRadius: '50%',
    border: '2px solid #F2A93B',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 26,
  },
  joinEyebrow: {
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: 4,
    fontSize: 12,
    color: '#F2A93B',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  joinTitle: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 34,
    fontWeight: 700,
    color: '#F5F5F0',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  joinSub: {
    fontSize: 13,
    color: '#9FB8AC',
    marginBottom: 26,
    lineHeight: 1.6,
  },
  storageWarning: {
    background: 'rgba(225,75,61,0.15)',
    border: '1px solid #E14B3D',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 12,
    color: '#F5F5F0',
    lineHeight: 1.6,
    marginBottom: 16,
    textAlign: 'left',
  },
  storageDiagnosticDetail: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: '1px solid rgba(225,75,61,0.3)',
    fontSize: 11,
    color: '#F5B8B0',
    fontFamily: 'monospace',
  },
  joinInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '15px 16px',
    fontSize: 16,
    borderRadius: 10,
    border: '1.5px solid #2A5744',
    background: '#0F4536',
    color: '#F5F5F0',
    marginBottom: 12,
    outline: 'none',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: 1,
  },
  joinBtn: {
    width: '100%',
    padding: '15px 16px',
    fontSize: 16,
    fontWeight: 700,
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(180deg, #FFC55C 0%, #F2A93B 100%)',
    color: '#12203A',
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(242,169,59,0.3)',
  },
  joinHint: {
    fontSize: 11,
    color: '#5B8973',
    marginTop: 18,
    lineHeight: 1.7,
  },
  toast: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#12203A',
    color: '#F5F5F0',
    padding: '10px 20px',
    borderRadius: 20,
    fontSize: 13,
    zIndex: 100,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    whiteSpace: 'nowrap',
    maxWidth: '90vw',
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    border: '1px solid #24344F',
  },
  roomBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 20px',
    background: '#0A1830',
    borderBottom: '1px solid #1B4A5C',
  },
  roomCodeTag: {
    fontSize: 12,
    letterSpacing: 1.5,
    color: '#7B93B0',
    fontFamily: "'Oswald', sans-serif",
  },
  leaveBtn: {
    background: 'transparent',
    border: '1px solid #24344F',
    color: '#7B93B0',
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 12,
    cursor: 'pointer',
  },
  scoreboard: {
    background: 'linear-gradient(180deg, #0F4536 0%, #0C3B2C 100%)',
    borderBottom: '2px solid #F2A93B',
    padding: '16px 20px 20px',
    position: 'relative',
  },
  scoreboardTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    letterSpacing: 2,
    color: '#F2A93B',
    fontFamily: "'Oswald', sans-serif",
    marginBottom: 12,
    justifyContent: 'space-between',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#E14B3D',
    display: 'inline-block',
    marginRight: 5,
    boxShadow: '0 0 6px rgba(225,75,61,0.8)',
  },
  hostToggle: {
    background: 'transparent',
    border: '1px solid #3A6E56',
    color: '#9FB8AC',
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 12,
    cursor: 'pointer',
  },
  hostBadge: {
    fontSize: 11,
    color: '#12203A',
    padding: '4px 10px',
    background: '#F2A93B',
    borderRadius: 12,
    fontWeight: 700,
  },
  scoreRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  teamBlock: {
    flex: 1,
    textAlign: 'center',
  },
  teamName: {
    fontSize: 13,
    color: '#DCE9E2',
    fontWeight: 500,
    marginBottom: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  teamNameInput: {
    fontSize: 13,
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid #2A5744',
    background: '#0B3D2E',
    color: '#F5F5F0',
    width: '90%',
    textAlign: 'center',
  },
  scoreBtns: {
    display: 'flex',
    gap: 6,
    justifyContent: 'center',
  },
  scoreBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: '1px solid #2A5744',
    background: '#12523F',
    color: '#F5F5F0',
    fontSize: 15,
    cursor: 'pointer',
    lineHeight: 1,
  },
  scoreNums: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 16px',
    background: 'rgba(0,0,0,0.25)',
    borderRadius: 10,
    border: '1px solid rgba(242,169,59,0.25)',
  },
  bigScore: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 40,
    fontWeight: 700,
    color: '#F5F5F0',
    minWidth: 36,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: -1,
    lineHeight: 1,
  },
  scoreColon: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 26,
    color: '#F2A93B',
    fontWeight: 700,
    lineHeight: 1,
  },
  editRow: {
    textAlign: 'center',
    marginTop: 10,
  },
  editLink: {
    background: 'transparent',
    border: 'none',
    color: '#F2A93B',
    fontSize: 12,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  chipsBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
  },
  chipsLabel: {
    fontSize: 11,
    color: '#9FB8AC',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  chipsValue: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 30,
    fontWeight: 700,
    color: '#F2A93B',
    fontVariantNumeric: 'tabular-nums',
  },
  leaderboardBtn: {
    background: '#12523F',
    border: '1px solid #F2A93B',
    color: '#F2A93B',
    padding: '9px 18px',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "'Oswald', sans-serif",
    letterSpacing: 0.5,
  },
  endedNotice: {
    margin: '0 20px 16px',
    padding: '14px',
    background: '#12203A',
    border: '1px solid #24344F',
    borderRadius: 10,
    fontSize: 13,
    color: '#9FB8AC',
    textAlign: 'center',
  },
  settleAlert: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: '0 20px 16px',
    padding: '12px 16px',
    background: 'linear-gradient(90deg, rgba(242,169,59,0.18), rgba(242,169,59,0.06))',
    border: '1px solid #F2A93B',
    borderRadius: 10,
    fontSize: 13,
    color: '#F2A93B',
    fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer',
  },
  settleAlertArrow: {
    fontSize: 12,
    fontWeight: 600,
  },
  wagerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 20px 16px',
    flexWrap: 'wrap',
  },
  wagerLabel: {
    fontSize: 12,
    color: '#9FB8AC',
    marginRight: 4,
  },
  wagerInput: {
    width: 70,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: '#0F4536',
    color: '#F5F5F0',
    fontSize: 14,
    fontFamily: "'Oswald', sans-serif",
  },
  chipQuick: {
    padding: '6px 13px',
    borderRadius: 16,
    border: '1px solid #2A5744',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: "'Oswald', sans-serif",
  },
  sectionLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: '#7FA595',
    fontFamily: "'Oswald', sans-serif",
    padding: '20px 20px 10px',
  },
  sectionDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#F2A93B',
    display: 'inline-block',
    marginRight: 8,
  },
  clockRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 20px 4px',
  },
  clockLabel: {
    fontSize: 15,
    color: '#F2A93B',
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  clockBtnStart: {
    padding: '8px 18px',
    borderRadius: 18,
    border: 'none',
    background: 'linear-gradient(180deg, #FFC55C 0%, #F2A93B 100%)',
    color: '#12203A',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  clockBtn: {
    padding: '8px 18px',
    borderRadius: 18,
    border: '1px solid #3A6E56',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  poolInfoRow: {
    fontSize: 11,
    color: '#7FA595',
    padding: '0 20px 10px',
  },
  noMatchState: {
    textAlign: 'center',
    padding: '60px 32px',
  },
  noMatchIcon: {
    fontSize: 40,
    marginBottom: 14,
    opacity: 0.6,
  },
  noMatchTitle: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 18,
    fontWeight: 700,
    color: '#F5F5F0',
    marginBottom: 8,
  },
  noMatchSub: {
    fontSize: 13,
    color: '#9FB8AC',
    lineHeight: 1.6,
    marginBottom: 24,
  },
  sharePriceTag: {
    fontSize: 10,
    color: '#7FA595',
    marginTop: 4,
  },
  settlePoolRow: {
    margin: '12px 20px 0',
    padding: '12px 14px',
    background: '#12203A',
    border: '1px solid #24344F',
    borderRadius: 10,
  },
  settlePoolLabel: {
    fontSize: 11,
    color: '#9FB8AC',
    display: 'block',
    marginBottom: 8,
  },
  settlePoolBtns: {
    display: 'flex',
    gap: 8,
  },
  settlePoolBtn: {
    flex: 1,
    padding: '8px 6px',
    borderRadius: 8,
    border: '1px solid #F2A93B',
    background: 'transparent',
    color: '#F2A93B',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  eventBtnWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  eventOddsEditRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  oddsAdjustBtn: {
    width: 20,
    height: 20,
    borderRadius: 5,
    border: '1px solid #2A5744',
    background: '#12523F',
    color: '#F5F5F0',
    fontSize: 12,
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
  },
  oddsAdjustLabel: {
    fontSize: 9,
    color: '#5B8973',
  },
  matchBetRow: {
    display: 'flex',
    gap: 10,
    padding: '0 20px',
  },
  matchBetBtn: {
    flex: 1,
    position: 'relative',
    background: 'linear-gradient(180deg, #12523F 0%, #0F4536 100%)',
    border: '1px solid #2A5744',
    borderRadius: 12,
    padding: '16px 8px',
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'transform 0.1s',
  },
  matchBetLabel: {
    fontSize: 12,
    color: '#DCE9E2',
    marginBottom: 8,
    fontWeight: 500,
  },
  matchBetPrice: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: '#F2A93B',
    fontVariantNumeric: 'tabular-nums',
  },
  priceUnit: {
    fontSize: 12,
    color: '#B8863F',
    marginLeft: 2,
    fontFamily: "'Noto Sans SC', sans-serif",
    fontWeight: 400,
  },
  eventGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    padding: '0 20px',
  },
  eventBtn: {
    background: '#0F4536',
    border: '1px solid #2A5744',
    borderLeft: '3px solid #F2A93B',
    borderRadius: 10,
    padding: '12px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    alignItems: 'flex-start',
    cursor: 'pointer',
    color: '#DCE9E2',
    fontSize: 12,
  },
  eventOdds: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 16,
    fontWeight: 700,
    color: '#F2A93B',
    fontVariantNumeric: 'tabular-nums',
  },
  customRow: {
    display: 'flex',
    gap: 8,
    padding: '0 20px',
  },
  customInput: {
    flex: 1,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: '#0F4536',
    color: '#F5F5F0',
    fontSize: 13,
  },
  customOddsInput: {
    width: 56,
    padding: '10px 8px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: '#0F4536',
    color: '#F5F5F0',
    fontSize: 13,
  },
  customBtn: {
    padding: '10px 14px',
    borderRadius: 8,
    border: 'none',
    background: '#F2A93B',
    color: '#12203A',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
  },
  pendingList: {
    padding: '0 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  pendingItem: {
    background: '#12203A',
    border: '1px solid #24344F',
    borderRadius: 10,
    padding: '10px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  pendingLabel: {
    fontSize: 13,
    color: '#F5F5F0',
  },
  pendingMeta: {
    fontSize: 11,
    color: '#7B93B0',
    marginTop: 2,
    fontVariantNumeric: 'tabular-nums',
  },
  pendingActions: {
    display: 'flex',
    gap: 6,
  },
  winBtn: {
    padding: '7px 12px',
    borderRadius: 8,
    border: 'none',
    background: '#2E9B6B',
    color: '#F5F5F0',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  loseBtn: {
    padding: '7px 12px',
    borderRadius: 8,
    border: 'none',
    background: '#E14B3D',
    color: '#F5F5F0',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  myBetsList: {
    padding: '0 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  emptyState: {
    fontSize: 13,
    color: '#5B8973',
    padding: '12px 0',
  },
  myBetItem: {
    background: '#0F4536',
    borderLeft: '3px solid #3A4F63',
    borderRadius: 8,
    padding: '10px 12px',
  },
  myBetLabel: {
    fontSize: 13,
    color: '#F5F5F0',
  },
  myBetMeta: {
    fontSize: 11,
    color: '#9FB8AC',
    marginTop: 2,
    fontVariantNumeric: 'tabular-nums',
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(4,15,10,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
    padding: 20,
  },
  modalCard: {
    background: '#0F4536',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    border: '1px solid #2A5744',
    maxHeight: '80vh',
    overflowY: 'auto',
  },
  modalTitle: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 16,
    color: '#F2A93B',
  },
  rankRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '9px 0',
    borderBottom: '1px solid #1D5C46',
    fontSize: 14,
  },
  rankNum: {
    width: 24,
    color: '#5B8973',
    fontFamily: "'Oswald', sans-serif",
  },
  rankName: {
    flex: 1,
    color: '#F5F5F0',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  rankTitleTag: {
    fontSize: 10,
    color: '#F2A93B',
  },
  rankHostTag: {
    fontSize: 9,
    color: '#F2A93B',
    border: '1px solid rgba(242, 169, 59, 0.4)',
    borderRadius: 6,
    padding: '1px 5px',
    display: 'inline-flex',
    alignItems: 'center',
    fontWeight: 700,
    background: 'rgba(242, 169, 59, 0.08)',
    lineHeight: 1.2,
  },
  rankChips: {
    fontFamily: "'Oswald', sans-serif",
    fontWeight: 700,
    color: '#F2A93B',
    fontVariantNumeric: 'tabular-nums',
  },
  closeModalBtn: {
    marginTop: 16,
    width: '100%',
    padding: '10px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: 'transparent',
    color: '#9FB8AC',
    cursor: 'pointer',
  },
  matchListWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 8,
  },
  matchListItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    gap: 8,
  },
  matchListTeams: {
    fontSize: 13,
    color: '#F5F5F0',
    fontVariantNumeric: 'tabular-nums',
  },
  matchListStatus: {
    fontSize: 11,
    color: '#7B93B0',
    marginTop: 2,
  },
  smallBtn: {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: 'transparent',
    color: '#F2A93B',
    fontSize: 11,
    cursor: 'pointer',
  },
  smallBtnEnd: {
    padding: '6px 10px',
    borderRadius: 8,
    border: 'none',
    background: '#E14B3D',
    color: '#F5F5F0',
    fontSize: 11,
    cursor: 'pointer',
  },
  oddsDisclaimer: {
    fontSize: 10,
    color: '#5B8973',
    padding: '4px 20px 4px',
    lineHeight: 1.5,
  },
  modeRow: {
    display: 'flex',
    gap: 8,
    marginTop: 10,
  },
  modeBtn: {
    flex: 1,
    padding: '10px 8px',
    borderRadius: 8,
    border: '1px solid #2A5744',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 11,
    cursor: 'pointer',
  },
  modeBtnActive: {
    border: '1px solid #F2A93B',
    color: '#F2A93B',
    background: 'rgba(242,169,59,0.1)',
  },
  viewBetsPrompt: {
    margin: '18px 20px 90px',
    padding: '12px 16px',
    background: '#0F4536',
    border: '1px solid #2A5744',
    borderRadius: 10,
    fontSize: 13,
    color: '#F2A93B',
    textAlign: 'center',
    cursor: 'pointer',
  },
  removeEventBtn: {
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid #E14B3D',
    background: 'transparent',
    color: '#E14B3D',
    fontSize: 10,
    cursor: 'pointer',
  },
  renameBtn: {
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid #3A6E56',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 10,
    cursor: 'pointer',
  },
  eventEditBox: {
    background: '#0F4536',
    border: '1px solid #F2A93B',
    borderRadius: 10,
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  eventEditInput: {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #2A5744',
    background: '#0B3D2E',
    color: '#F5F5F0',
    fontSize: 12,
  },
  eventEditOddsInput: {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #2A5744',
    background: '#0B3D2E',
    color: '#F5F5F0',
    fontSize: 12,
  },
  eventEditBtnRow: {
    display: 'flex',
    gap: 6,
  },
  eventEditSaveBtn: {
    flex: 1,
    padding: '7px',
    borderRadius: 6,
    border: 'none',
    background: '#F2A93B',
    color: '#12203A',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  eventEditCancelBtn: {
    flex: 1,
    padding: '7px',
    borderRadius: 6,
    border: '1px solid #3A6E56',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 11,
    cursor: 'pointer',
  },
  tabBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    background: '#0A1830',
    borderTop: '1px solid #1B4A5C',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    zIndex: 150,
  },
  tabBarBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    padding: '10px 0 8px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  tabBarIcon: {
    fontSize: 18,
  },
  tabBarLabel: {
    fontSize: 10,
    fontFamily: "'Oswald', sans-serif",
  },
  betsFilterRow: {
    display: 'flex',
    gap: 8,
    padding: '14px 20px',
  },
  betsFilterBtn: {
    flex: 1,
    padding: '10px 8px',
    borderRadius: 10,
    border: '1px solid #2A5744',
    background: '#0F4536',
    color: '#9FB8AC',
    fontSize: 12,
    cursor: 'pointer',
  },
  betsFilterBtnActive: {
    border: '1px solid #F2A93B',
    color: '#F2A93B',
    background: 'rgba(242,169,59,0.1)',
  },
  betsFeedList: {
    padding: '0 20px 90px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  betsFeedItem: {
    background: '#0F4536',
    border: '1px solid #2A5744',
    borderRadius: 10,
    padding: '12px 14px',
  },
  betsFeedTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  betsFeedPlayer: {
    fontSize: 13,
    fontWeight: 600,
    color: '#F5F5F0',
  },
  betsFeedStatus: {
    fontSize: 12,
    fontWeight: 600,
  },
  betsFeedLabel: {
    fontSize: 13,
    color: '#DCE9E2',
    marginBottom: 4,
  },
  betsFeedMeta: {
    fontSize: 11,
    color: '#7B93B0',
    fontVariantNumeric: 'tabular-nums',
  },
};

const confirmStyles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2,10,7,0.8)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 250,
  },
  whistleBar: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    background: 'linear-gradient(90deg, #E14B3D, #F2A93B, #E14B3D)',
    zIndex: 251,
  },
  card: {
    position: 'relative',
    width: '100%',
    maxWidth: 480,
    background: 'linear-gradient(180deg, #12523F 0%, #0C3B2C 100%)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: '28px 24px 28px',
    border: '1px solid #2A5744',
    borderBottom: 'none',
    boxShadow: '0 -8px 30px rgba(0,0,0,0.4)',
    fontFamily: "'Noto Sans SC', sans-serif",
    color: '#F5F5F0',
  },
  cardTopStripe: {
    position: 'absolute',
    top: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 40,
    height: 4,
    borderRadius: 2,
    background: '#3A6E56',
    marginTop: 10,
  },
  eyebrow: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 11,
    letterSpacing: 3,
    color: '#F2A93B',
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 10,
  },
  betLabel: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: '#F5F5F0',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  oddsRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginBottom: 20,
  },
  oddsBig: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 48,
    fontWeight: 700,
    color: '#F2A93B',
    fontVariantNumeric: 'tabular-nums',
  },
  oddsBigX: {
    fontSize: 22,
    color: '#B8863F',
    marginLeft: 2,
  },
  detailGrid: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    background: 'rgba(0,0,0,0.2)',
    borderRadius: 12,
    padding: '16px 20px',
    marginBottom: 14,
  },
  detailBox: {
    textAlign: 'center',
    flex: 1,
  },
  detailLabel: {
    fontSize: 11,
    color: '#9FB8AC',
    marginBottom: 4,
  },
  detailValue: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 24,
    fontWeight: 700,
    color: '#F5F5F0',
    fontVariantNumeric: 'tabular-nums',
  },
  detailArrow: {
    color: '#5B8973',
    fontSize: 18,
  },
  footRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 12,
    color: '#9FB8AC',
    padding: '0 4px',
    marginBottom: 10,
  },
  poolNote: {
    fontSize: 11,
    color: '#7B93B0',
    lineHeight: 1.6,
    padding: '10px 12px',
    background: 'rgba(0,0,0,0.2)',
    borderRadius: 8,
    marginBottom: 20,
  },
  btnRow: {
    display: 'flex',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    padding: '15px',
    borderRadius: 10,
    border: '1px solid #3A6E56',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  confirmBtn: {
    flex: 2,
    padding: '15px',
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(180deg, #FFC55C 0%, #F2A93B 100%)',
    color: '#12203A',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.5,
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(242,169,59,0.35)',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    background: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 2,
    margin: '0 auto 16px',
    display: 'block',
  },
  welcomeBanner: {
    background: 'rgba(242, 169, 59, 0.12)',
    borderBottom: '1px solid rgba(242, 169, 59, 0.3)',
    color: '#FFD175',
    padding: '12px 20px',
    fontSize: 13,
    lineHeight: 1.5,
  },
  welcomeBannerContent: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    maxWidth: 1126,
    margin: '0 auto',
  },
  welcomeBannerClose: {
    background: 'transparent',
    border: 'none',
    color: '#FFD175',
    fontSize: 20,
    cursor: 'pointer',
    padding: '0 5px',
    lineHeight: 1,
  },
};

const recapStyles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 300,
    padding: 20,
  },
  card: {
    position: 'relative',
    width: '100%',
    maxWidth: 360,
    background: 'linear-gradient(180deg, #0F4536 0%, #0B3D2E 100%)',
    borderRadius: 20,
    border: '1px solid #2A5744',
    padding: '32px 24px 24px',
    maxHeight: '85vh',
    overflowY: 'auto',
    fontFamily: "'Noto Sans SC', sans-serif",
    color: '#F5F5F0',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '1px solid #2A5744',
    background: 'transparent',
    color: '#9FB8AC',
    fontSize: 16,
    cursor: 'pointer',
    lineHeight: 1,
  },
  eyebrow: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 11,
    letterSpacing: 3,
    color: '#F2A93B',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  roomTag: {
    fontSize: 11,
    color: '#5B8973',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 20,
  },
  championBlock: {
    textAlign: 'center',
    marginBottom: 20,
  },
  championEmoji: {
    fontSize: 40,
    marginBottom: 6,
  },
  championName: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 26,
    fontWeight: 700,
    color: '#F5F5F0',
  },
  championSub: {
    fontSize: 12,
    color: '#F2A93B',
    marginTop: 2,
  },
  statsRow: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '16px 0',
    borderTop: '1px solid #1D5C46',
    borderBottom: '1px solid #1D5C46',
    marginBottom: 18,
  },
  statBox: {
    textAlign: 'center',
  },
  statNum: {
    fontFamily: "'Oswald', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: '#F2A93B',
  },
  statLabel: {
    fontSize: 10,
    color: '#9FB8AC',
    marginTop: 2,
  },
  dramaticBlock: {
    background: '#12203A',
    border: '1px solid #24344F',
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 18,
  },
  dramaticLabel: {
    fontSize: 10,
    letterSpacing: 1,
    color: '#7B93B0',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  dramaticText: {
    fontSize: 13,
    color: '#F5F5F0',
    lineHeight: 1.5,
  },
  dramaticPayout: {
    fontSize: 12,
    color: '#F2A93B',
    marginTop: 4,
    fontWeight: 700,
  },
  titleSection: {
    marginBottom: 8,
  },
  titleSectionLabel: {
    fontSize: 11,
    letterSpacing: 2,
    color: '#5B8973',
    fontFamily: "'Oswald', sans-serif",
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  noTitles: {
    fontSize: 12,
    color: '#5B8973',
    textAlign: 'center',
    padding: '8px 0',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 0',
    borderBottom: '1px solid #1D5C46',
  },
  titleEmoji: {
    fontSize: 18,
  },
  titleName: {
    flex: 1,
    fontSize: 13,
    color: '#F5F5F0',
  },
  titleLabel: {
    fontSize: 12,
    color: '#F2A93B',
  },
  historySection: {
    marginTop: 18,
    borderTop: '1px solid #1D5C46',
    paddingTop: 14,
    textAlign: 'left',
  },
  historyList: {
    maxHeight: 150,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    paddingRight: 4,
    marginTop: 8,
  },
  historyRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 11,
    padding: '6px 8px',
    background: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 6,
    border: '1px solid rgba(42, 87, 68, 0.4)',
  },
  historyLeft: {
    display: 'flex',
    gap: 4,
    color: '#F5F5F0',
    flexWrap: 'wrap',
  },
  historyPlayer: {
    fontWeight: 700,
    color: '#FFD175',
  },
  historyLabel: {
    color: '#9FB8AC',
  },
  historyRight: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  historyAmount: {
    color: '#9FB8AC',
    fontSize: 10,
  },
  historyStatus: {
    fontWeight: 700,
  },
  footer: {
    textAlign: 'center',
    fontSize: 10,
    color: '#3A6E56',
    marginTop: 20,
  },
};
