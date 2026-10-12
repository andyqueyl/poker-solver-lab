// No-limit hold'em table engine for Play with Friends. Pure rules and state, no DOM or network: the host's
// browser runs it and sends every player a view that holds only their own hole cards.
// Cards are 0..51: rank = c >> 2 (0 = deuce, 12 = ace), suit = c & 3 (spades, hearts, diamonds, clubs).
(function (root) {
  'use strict';
  const RANKS = '23456789TJQKA';
  const RANK_NAME = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
  const STREETS = ['Preflop', 'Flop', 'Turn', 'River'];
  const MAX_SEATS = 9;
  const RUNOUT_MS = 1100, END_MS = 4500, END_FOLD_MS = 2200, OFFLINE_THINK_S = 30;

  // ---------- hand evaluation ----------
  function eval5(cs) {
    const r = cs.map((c) => c >> 2).sort((a, b) => b - a);
    const flush = cs.every((c) => (c & 3) === (cs[0] & 3));
    const uniq = [...new Set(r)];
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (r[0] - r[4] === 4) straightHigh = r[0];
      else if (r[0] === 12 && r[1] === 3) straightHigh = 3; // A-2-3-4-5
    }
    const counts = new Map();
    for (const x of r) counts.set(x, (counts.get(x) || 0) + 1);
    const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const shape = groups.map((g) => g[1]).join('');
    let cat, ranks;
    if (straightHigh >= 0 && flush) { cat = 8; ranks = [straightHigh]; }
    else if (shape === '41') { cat = 7; ranks = groups.map((g) => g[0]); }
    else if (shape === '32') { cat = 6; ranks = groups.map((g) => g[0]); }
    else if (flush) { cat = 5; ranks = r; }
    else if (straightHigh >= 0) { cat = 4; ranks = [straightHigh]; }
    else if (shape === '311') { cat = 3; ranks = groups.map((g) => g[0]); }
    else if (shape === '221') { cat = 2; ranks = groups.map((g) => g[0]); }
    else if (shape === '2111') { cat = 1; ranks = groups.map((g) => g[0]); }
    else { cat = 0; ranks = r; }
    let score = cat;
    for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
    return { score, cat, ranks };
  }
  function handName(e) {
    const [a, b] = e.ranks;
    switch (e.cat) {
      case 8: return a === 12 ? 'Royal flush' : `Straight flush, ${RANK_NAME[a]} high`;
      case 7: return `Four ${RANK_PLURAL[a]}`;
      case 6: return `Full house, ${RANK_PLURAL[a]} full of ${RANK_PLURAL[b]}`;
      case 5: return `Flush, ${RANK_NAME[a]} high`;
      case 4: return `Straight, ${RANK_NAME[a]} high`;
      case 3: return `Three ${RANK_PLURAL[a]}`;
      case 2: return `Two pair, ${RANK_PLURAL[a]} and ${RANK_PLURAL[b]}`;
      case 1: return `Pair of ${RANK_PLURAL[a]}`;
      default: return `${RANK_NAME[a]} high`;
    }
  }
  // Best five of up to seven cards: { score, name, cards }.
  function bestHand(cards) {
    let best = null;
    const n = cards.length;
    const pick = (start, chosen) => {
      if (chosen.length === 5) {
        const e = eval5(chosen);
        if (!best || e.score > best.e.score) best = { e, cards: chosen.slice() };
        return;
      }
      for (let i = start; i <= n - (5 - chosen.length); i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop(); }
    };
    if (n >= 5) pick(0, []);
    else {
      // Fewer than five cards (preflop describe): name pairs or high card only.
      const r = cards.map((c) => c >> 2).sort((x, y) => y - x);
      const e = r[0] === r[1] ? { cat: 1, ranks: [r[0]] } : { cat: 0, ranks: r };
      return { score: 0, name: handName(e), cards: [] };
    }
    return { score: best.e.score, name: handName(best.e), cards: best.cards };
  }

  // ---------- settings ----------
  const DEFAULTS = { sb: 10, bb: 20, ante: 0, stack: 2000, think: 30, bank: 60, maxPlayers: 9, levelMins: 0, rebuys: true };
  function cleanSettings(s, prev) {
    const o = Object.assign({}, DEFAULTS, prev || {}, s || {});
    const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
    o.bb = int(o.bb, 1, 1e9);
    o.sb = int(o.sb, 0, o.bb);
    o.ante = int(o.ante, 0, o.bb * 10);
    o.stack = int(o.stack, o.bb, 1e12);
    o.think = int(o.think, 0, 600);
    o.bank = int(o.bank, 0, 3600);
    o.maxPlayers = int(o.maxPlayers, 2, MAX_SEATS);
    o.levelMins = int(o.levelMins, 0, 240);
    o.rebuys = !!o.rebuys;
    return o;
  }
  // Blind levels grow by about 1.5x and round to familiar numbers.
  function niceRound(x) {
    if (x <= 2) return Math.max(1, Math.round(x));
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    let best = steps[0] * p;
    for (const s of steps) if (Math.abs(s * p - x) < Math.abs(best - x)) best = s * p;
    return Math.round(best);
  }
  function blindsAt(settings, level) {
    if (!level) return { sb: settings.sb, bb: settings.bb, ante: settings.ante, level: 0 };
    const bb = niceRound(settings.bb * Math.pow(1.5, level));
    const k = bb / settings.bb;
    return { sb: Math.min(bb, Math.round(settings.sb * k)), bb, ante: settings.ante ? Math.max(1, Math.round(settings.ante * k)) : 0, level };
  }

  // ---------- table ----------
  function createTable(settings, hostId) {
    const s = cleanSettings(settings);
    return {
      v: 1, settings: s, hostId, seats: new Array(MAX_SEATS).fill(null), players: {}, banned: {},
      button: -1, hand: null, handNo: 0, started: false, paused: false, pausedAt: 0,
      clock: { ms: 0, since: null }, blinds: blindsAt(s, 0), nextAt: 0,
      log: [], chat: [], seq: 0,
    };
  }
  function addLog(t, text, kind) { t.log.push({ at: Date.now(), text, kind: kind || '' }); if (t.log.length > 300) t.log.splice(0, t.log.length - 300); }
  const nm = (t, id) => (t.players[id] ? t.players[id].name : 'Someone');
  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  function join(t, id, name) {
    if (t.banned[id]) return 'You were removed from this room.';
    name = String(name || '').trim().slice(0, 18) || 'Player';
    const p = t.players[id];
    if (p) { p.name = name; p.connected = true; return null; }
    t.players[id] = { id, pub: Math.random().toString(36).slice(2, 10), name, seat: -1, stack: 0, buyIn: 0, sittingOut: false, timeouts: 0, bank: t.settings.bank, connected: true, wantOut: false };
    addLog(t, `${name} joined the room`, 'sys');
    return null;
  }
  function sit(t, id, seat) {
    const p = t.players[id];
    if (!p) return 'Join the room first.';
    if (p.seat >= 0) return 'You already have a seat.';
    if (!(seat >= 0 && seat < t.settings.maxPlayers) || t.seats[seat]) return 'That seat is taken.';
    if (p.stack <= 0) { p.stack = t.settings.stack; p.buyIn += t.settings.stack; }
    p.seat = seat; p.sittingOut = false; p.timeouts = 0; p.bank = t.settings.bank;
    t.seats[seat] = id;
    addLog(t, `${p.name} sat down with ${fmt(p.stack)}`, 'sys');
    return null;
  }
  function stand(t, id, now) {
    const p = t.players[id];
    if (!p || p.seat < 0) return 'You are not seated.';
    const h = t.hand;
    if (h && h.phase !== 'done' && h.ps[p.seat] && !h.ps[p.seat].folded) foldOut(t, p.seat, now);
    // Chips still in the pot stay there; the player keeps the rest.
    t.seats[p.seat] = null;
    addLog(t, `${p.name} stood up with ${fmt(p.stack)}`, 'sys');
    p.seat = -1;
    return null;
  }
  function rebuy(t, id) {
    const p = t.players[id];
    if (!p || p.seat < 0) return 'Sit down first.';
    if (!t.settings.rebuys) return 'Rebuys are turned off.';
    if (inHand(t, p.seat)) return 'Wait until this hand ends.';
    if (p.stack >= t.blinds.bb) return 'You can rebuy once you run out of chips.';
    p.stack += t.settings.stack; p.buyIn += t.settings.stack; p.sittingOut = false; p.timeouts = 0;
    addLog(t, `${p.name} rebought for ${fmt(t.settings.stack)}`, 'sys');
    return null;
  }
  function setStack(t, id, amount) {
    const p = t.players[id];
    if (!p) return 'No such player.';
    if (p.seat >= 0 && inHand(t, p.seat)) return 'Change it after this hand.';
    amount = Math.max(0, Math.round(+amount || 0));
    p.buyIn += amount - p.stack; p.stack = amount;
    addLog(t, `The host set ${p.name}'s stack to ${fmt(amount)}`, 'sys');
    return null;
  }
  function kick(t, id, now) {
    const p = t.players[id];
    if (!p || id === t.hostId) return 'No such player.';
    if (p.seat >= 0) stand(t, id, now);
    t.banned[id] = true;
    delete t.players[id];
    addLog(t, `${p.name} was removed by the host`, 'sys');
    return null;
  }
  function setSittingOut(t, id, on) {
    const p = t.players[id];
    if (!p || p.seat < 0) return 'You are not seated.';
    p.sittingOut = !!on; if (!on) p.timeouts = 0;
    return null;
  }
  function updateSettings(t, s, now) {
    const old = t.settings, next = cleanSettings(s, old);
    for (let i = next.maxPlayers; i < MAX_SEATS; i++) if (t.seats[i]) next.maxPlayers = i + 1;
    const blindsChanged = next.sb !== old.sb || next.bb !== old.bb || next.ante !== old.ante || next.levelMins !== old.levelMins;
    t.settings = next;
    if (blindsChanged) { t.clock = { ms: 0, since: t.started && !t.paused ? now : null }; t.blinds = blindsAt(next, 0); }
    if (next.bank !== old.bank) for (const p of Object.values(t.players)) p.bank = next.bank;
    addLog(t, 'The host changed the table settings' + (t.hand && t.hand.phase !== 'done' ? ' (from the next hand)' : ''), 'sys');
    return null;
  }

  // ---------- hand flow ----------
  const occupied = (t) => t.seats.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
  function eligibleSeats(t) {
    return occupied(t).filter((i) => { const p = t.players[t.seats[i]]; return p && !p.sittingOut && p.stack > 0; });
  }
  function inHand(t, seat) { const h = t.hand; return !!(h && h.phase !== 'done' && h.ps[seat]); }
  function nextIn(list, from) { // next seat in a sorted list strictly after `from`, wrapping
    for (const s of list) if (s > from) return s;
    return list[0];
  }
  // Cards are drawn one at a time, at the moment they're dealt, from the cards not yet out. Nothing is
  // shuffled ahead of time, so the flop, turn and river don't exist anywhere until their street comes.
  let rng = Math.random;
  function setRandom(f) { rng = f; }
  function draw(h) {
    const i = Math.floor(rng() * h.left.length);
    return h.left.splice(i, 1)[0];
  }
  function canStart(t) { return eligibleSeats(t).length >= 2; }

  function startHand(t, now) {
    const seats = eligibleSeats(t);
    if (seats.length < 2) return 'Two players with chips need to be seated.';
    if (!t.started) { t.started = true; t.clock = { ms: 0, since: now }; }
    // blind level
    if (t.settings.levelMins > 0) {
      const ms = t.clock.ms + (t.clock.since != null ? now - t.clock.since : 0);
      const level = Math.floor(ms / (t.settings.levelMins * 60000));
      if (level !== t.blinds.level) {
        t.blinds = blindsAt(t.settings, level);
        addLog(t, `Blinds are up: ${fmt(t.blinds.sb)} / ${fmt(t.blinds.bb)}${t.blinds.ante ? ', ante ' + fmt(t.blinds.ante) : ''}`, 'level');
      }
    } else t.blinds = blindsAt(t.settings, 0);
    const { sb, bb, ante } = t.blinds;
    t.button = t.button < 0 ? seats[Math.floor(rng() * seats.length)] : nextIn(seats, t.button);
    const hu = seats.length === 2;
    const sbSeat = hu ? t.button : nextIn(seats, t.button);
    const bbSeat = nextIn(seats, sbSeat);
    const ps = {};
    for (const s of seats) {
      const p = t.players[t.seats[s]];
      ps[s] = { id: p.id, cards: [], bet: 0, total: 0, folded: false, allin: false, acted: false, level: 0, start: p.stack, last: '' };
    }
    t.handNo++;
    const h = t.hand = {
      no: t.handNo, button: t.button, sbSeat, bbSeat, seats, left: Array.from({ length: 52 }, (_, i) => i), board: [], street: 0, ps,
      curBet: 0, minRaise: bb, fullTo: 0, toAct: -1, turnAt: 0, deadline: 0, phase: 'betting',
      nextAt: 0, results: null, shown: {}, reveal: false, bb, actions: [],
    };
    addLog(t, `Hand #${h.no} · ${nm(t, t.seats[t.button])} has the button · blinds ${fmt(sb)} / ${fmt(bb)}${ante ? ', ante ' + fmt(ante) : ''}`, 'hand');
    const put = (s, amt) => {
      const p = t.players[ps[s].id], x = Math.min(amt, p.stack);
      p.stack -= x; ps[s].total += x;
      if (p.stack === 0) ps[s].allin = true;
      return x;
    };
    if (ante) for (const s of seats) put(s, ante);
    const postBlind = (s, amt, label) => {
      if (ps[s].allin) return;
      const x = put(s, amt); ps[s].bet += x; ps[s].last = `${label} ${fmt(x)}`;
    };
    postBlind(sbSeat, sb, 'SB'); postBlind(bbSeat, bb, 'BB');
    h.curBet = bb; h.fullTo = bb;
    // deal two cards each, one at a time, starting left of the button
    const order = []; let s0 = t.button;
    for (let i = 0; i < seats.length; i++) { s0 = nextIn(seats, s0); order.push(s0); }
    for (let r = 0; r < 2; r++) for (const s of order) ps[s].cards.push(draw(h));
    h.toAct = hu ? sbSeat : nextIn(seats, bbSeat);
    if (!needsAction(h, h.toAct)) h.toAct = findNext(h, h.toAct);
    if (h.toAct < 0) closeRound(t, now); else beginTurn(t, now);
    return null;
  }
  function active(h, s) { const p = h.ps[s]; return p && !p.folded && !p.allin; }
  function needsAction(h, s) { const p = h.ps[s]; return active(h, s) && (!p.acted || p.bet < h.curBet); }
  function findNext(h, from) {
    let s = from;
    for (let i = 0; i < h.seats.length; i++) { s = nextIn(h.seats, s); if (needsAction(h, s)) return s; }
    return -1;
  }
  function liveSeats(h) { return h.seats.filter((s) => !h.ps[s].folded); }
  function beginTurn(t, now) {
    const h = t.hand, p = t.players[h.ps[h.toAct].id];
    h.turnAt = now;
    const think = t.settings.think || (p && !p.connected ? OFFLINE_THINK_S : 0);
    h.deadline = think ? now + think * 1000 : 0;
  }

  // What the player to act may do: { fold, check, call, raise: { min, max } | null } with to-amounts.
  function legal(t, seat) {
    const h = t.hand;
    if (!h || h.phase !== 'betting' || h.toAct !== seat) return null;
    const ps = h.ps[seat], p = t.players[ps.id];
    const toCall = Math.max(0, h.curBet - ps.bet);
    const maxTo = ps.bet + p.stack;
    let raise = null;
    const reopened = !ps.acted || h.fullTo > ps.level;
    const others = h.seats.some((s) => s !== seat && active(h, s));
    if (p.stack > toCall && reopened && others) {
      const minTo = h.curBet === 0 ? Math.min(h.bb, maxTo) : Math.min(h.curBet + h.minRaise, maxTo);
      raise = { min: minTo, max: maxTo, bet: h.curBet === 0 };
    }
    return { fold: toCall > 0, check: toCall === 0, call: toCall > 0 ? Math.min(toCall, p.stack) : 0, raise, toCall, pot: potTotal(h) };
  }
  function potTotal(h) { return h.seats.reduce((s, x) => s + h.ps[x].total, 0); }

  // a = { type: 'fold'|'check'|'call'|'raise', to }
  function act(t, seat, a, now, auto) {
    const h = t.hand;
    if (t.paused) return 'The game is paused.';
    const L = legal(t, seat);
    if (!L) return "It's not your turn.";
    const ps = h.ps[seat], p = t.players[ps.id];
    const type = a && a.type;
    let text;
    if (type === 'fold') {
      if (L.check) return act(t, seat, { type: 'check' }, now, auto); // never fold for free
      ps.folded = true; text = 'folds'; ps.last = 'Fold';
    } else if (type === 'check') {
      if (!L.check) return 'You cannot check here.';
      text = 'checks'; ps.last = 'Check';
    } else if (type === 'call') {
      if (!L.call) return act(t, seat, { type: 'check' }, now, auto);
      const x = L.call; p.stack -= x; ps.bet += x; ps.total += x;
      if (p.stack === 0) ps.allin = true;
      text = ps.allin ? `calls ${fmt(x)} and is all-in` : `calls ${fmt(x)}`; ps.last = ps.allin ? 'All-in' : `Call ${fmt(ps.bet)}`;
    } else if (type === 'raise') {
      if (!L.raise) return 'You cannot raise here.';
      let to = Math.round(+a.to || 0);
      to = Math.max(L.raise.min, Math.min(L.raise.max, to));
      const add = to - ps.bet;
      p.stack -= add; ps.bet = to; ps.total += add;
      if (p.stack === 0) ps.allin = true;
      const inc = to - h.curBet;
      const wasBet = h.curBet === 0;
      if (wasBet ? to >= h.bb : inc >= h.minRaise) { h.minRaise = Math.max(inc, h.bb); h.fullTo = to; }
      h.curBet = Math.max(h.curBet, to);
      text = `${wasBet ? 'bets' : 'raises to'} ${fmt(to)}${ps.allin ? ' and is all-in' : ''}`;
      ps.last = ps.allin ? 'All-in' : `${wasBet ? 'Bet' : 'Raise'} ${fmt(to)}`;
    } else return 'Unknown action.';
    ps.acted = true; ps.level = h.curBet;
    if (!auto) { p.timeouts = 0; }
    // time bank
    if (h.deadline && now > h.deadline && t.settings.bank) p.bank = Math.max(0, p.bank - (now - h.deadline) / 1000);
    h.actions.push({ street: h.street, seat, text, auto: !!auto });
    addLog(t, `${p.name} ${text}${auto ? ' (timed out)' : ''}`, 'act');
    afterAction(t, seat, now);
    return null;
  }
  function foldOut(t, seat, now) { // fold out of turn (standing up or removed)
    const h = t.hand, ps = h.ps[seat];
    ps.folded = true; ps.last = 'Fold';
    h.actions.push({ street: h.street, seat, text: 'folds', auto: true });
    addLog(t, `${nm(t, ps.id)} folds`, 'act');
    if (h.phase === 'betting') {
      if (h.toAct === seat) afterAction(t, seat, now);
      else if (liveSeats(h).length === 1) finishHand(t, now);
    } else if (liveSeats(h).length === 1) finishHand(t, now);
  }
  function afterAction(t, seat, now) {
    const h = t.hand;
    if (liveSeats(h).length === 1) return finishHand(t, now);
    const nx = findNext(h, seat);
    if (nx < 0) return closeRound(t, now);
    h.toAct = nx; beginTurn(t, now);
  }
  function closeRound(t, now) {
    const h = t.hand;
    h.toAct = -1; h.deadline = 0;
    if (liveSeats(h).length === 1) return finishHand(t, now);
    const canBet = h.seats.filter((s) => active(h, s)).length;
    if (h.street === 3) return finishHand(t, now);
    if (canBet <= 1) { // nobody left to bet against: show cards and run the board out
      h.phase = 'runout'; h.reveal = true; h.nextAt = now + RUNOUT_MS;
      for (const s of h.seats) h.ps[s].bet = 0;
      return;
    }
    nextStreet(t, now);
    const first = findNext(h, h.button);
    if (first < 0) return closeRound(t, now);
    h.toAct = first; beginTurn(t, now);
  }
  function nextStreet(t) {
    const h = t.hand;
    h.street++;
    const n = h.street === 1 ? 3 : 1;
    for (let i = 0; i < n; i++) h.board.push(draw(h));
    for (const s of h.seats) { const ps = h.ps[s]; ps.bet = 0; ps.acted = false; ps.level = 0; if (!ps.folded && !ps.allin) ps.last = ''; }
    h.curBet = 0; h.minRaise = h.bb; h.fullTo = 0;
    addLog(t, `${STREETS[h.street]}: ${h.board.map(cardStr).join(' ')}`, 'board');
  }

  // Pots from total contributions: each level of the smallest live contribution forms a pot.
  function buildPots(h) {
    const e = h.seats.map((s) => ({ s, left: h.ps[s].total, folded: h.ps[s].folded }));
    const pots = [];
    for (;;) {
      const live = e.filter((x) => !x.folded && x.left > 0);
      const rest = e.reduce((a, x) => a + x.left, 0);
      if (!rest) break;
      if (!live.length) { if (pots.length) pots[pots.length - 1].amount += rest; break; }
      const cap = Math.min(...live.map((x) => x.left));
      let amount = 0;
      for (const x of e) { const take = Math.min(x.left, cap); x.left -= take; amount += take; }
      const eligible = live.map((x) => x.s);
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.join() === eligible.join()) prev.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }
  function finishHand(t, now) {
    const h = t.hand;
    h.toAct = -1; h.deadline = 0;
    const live = liveSeats(h);
    const showdown = live.length > 1;
    while (showdown && h.board.length < 5) h.board.push(draw(h));
    const pots = buildPots(h);
    const evals = {};
    if (showdown) for (const s of live) evals[s] = bestHand([...h.ps[s].cards, ...h.board]);
    const won = {};
    const results = [];
    // odd chips go to the first winner left of the button
    const leftOfButton = (a, b) => ((a - h.button + MAX_SEATS) % MAX_SEATS || MAX_SEATS) - ((b - h.button + MAX_SEATS) % MAX_SEATS || MAX_SEATS);
    pots.forEach((pot, i) => {
      let winners;
      if (pot.eligible.length === 1) winners = pot.eligible;
      else {
        const best = Math.max(...pot.eligible.map((s) => evals[s].score));
        winners = pot.eligible.filter((s) => evals[s].score === best).sort(leftOfButton);
      }
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const s of winners) { const x = share + (odd-- > 0 ? 1 : 0); won[s] = (won[s] || 0) + x; }
      results.push({ amount: pot.amount, winners, returned: pot.eligible.length === 1 && i > 0 && showdown, name: pots.length > 1 ? (i === 0 ? 'Main pot' : `Side pot ${i}`) : 'Pot' });
    });
    for (const s of Object.keys(won)) t.players[h.ps[s].id].stack += won[s];
    for (const s of h.seats) h.ps[s].bet = 0;
    h.phase = 'done'; h.reveal = showdown; if (showdown) h.street = 3;
    h.results = { pots: results, won, showdown, hands: Object.fromEntries(Object.entries(evals).map(([s, e]) => [s, { name: e.name, cards: e.cards }])) };
    h.nextAt = now + (showdown ? END_MS : END_FOLD_MS);
    for (const r of results) {
      const names = r.winners.map((s) => nm(t, h.ps[s].id)).join(' and ');
      if (r.returned) addLog(t, `${fmt(r.amount)} uncalled returned to ${names}`, 'win');
      else addLog(t, `${names} ${r.winners.length > 1 ? 'split' : 'wins'} ${r.name.toLowerCase()} of ${fmt(r.amount)}${showdown && r.winners.length ? ' with ' + evals[r.winners[0]].name.toLowerCase() : ''}`, 'win');
    }
    if (showdown) for (const s of live) addLog(t, `${nm(t, h.ps[s].id)} shows ${h.ps[s].cards.map(cardStr).join(' ')}`, 'show');
    // stand busted players' chips at zero; they can rebuy or stand up
    for (const s of h.seats) { const p = t.players[h.ps[s].id]; if (p && p.stack === 0) p.sittingOut = false; }
  }
  function showCards(t, id) {
    const h = t.hand, p = t.players[id];
    if (!h || !p || h.phase !== 'done') return 'You can show after the hand.';
    const seat = Object.keys(h.ps).find((s) => h.ps[s].id === id);
    if (seat == null) return 'You were not in this hand.';
    if (!h.shown[seat]) { h.shown[seat] = true; addLog(t, `${p.name} shows ${h.ps[seat].cards.map(cardStr).join(' ')}`, 'show'); }
    return null;
  }

  // Timed transitions: timeouts, runout streets, the next hand. Returns true when state changed.
  function tick(t, now) {
    if (t.paused) return false;
    const h = t.hand;
    if (h && h.phase === 'betting' && h.toAct >= 0) {
      const ps = h.ps[h.toAct], p = t.players[ps.id];
      if (!h.deadline && p && !p.connected && !t.settings.think) { h.deadline = now + OFFLINE_THINK_S * 1000; return true; }
      const bank = t.settings.think && p ? p.bank * 1000 : 0;
      if (h.deadline && now >= h.deadline + bank) {
        const seat = h.toAct;
        p.timeouts++;
        act(t, seat, { type: 'fold' }, now, true);
        if (p.timeouts >= 2 || !p.connected) { p.sittingOut = true; addLog(t, `${p.name} is sitting out`, 'sys'); }
        return true;
      }
      return false;
    }
    if (h && h.phase === 'runout' && now >= h.nextAt) {
      if (h.board.length < 5) { nextStreet(t, now); for (const s of h.seats) h.ps[s].bet = 0; h.nextAt = now + RUNOUT_MS; if (h.board.length === 5) h.nextAt = now + RUNOUT_MS * 0.8; }
      else finishHand(t, now);
      return true;
    }
    if (t.started && (!h || h.phase === 'done') && now >= (h ? h.nextAt : 0) && canStart(t)) {
      startHand(t, now);
      return true;
    }
    return false;
  }
  function setPaused(t, on, now) {
    if (!!on === t.paused) return null;
    const h = t.hand;
    if (on) {
      t.paused = true; t.pausedAt = now;
      if (t.clock.since != null) { t.clock.ms += now - t.clock.since; t.clock.since = null; }
      addLog(t, 'The host paused the game', 'sys');
    } else {
      const d = now - t.pausedAt;
      t.paused = false;
      if (h) { if (h.deadline) h.deadline += d; if (h.nextAt) h.nextAt += d; }
      if (t.started) t.clock.since = now;
      addLog(t, 'The host resumed the game', 'sys');
    }
    return null;
  }
  function startGame(t, now) {
    if (t.started) return 'The game is already running.';
    if (!canStart(t)) return 'Two players with chips need to be seated.';
    addLog(t, 'The host started the game', 'sys');
    return startHand(t, now);
  }

  function cardStr(c) { return RANKS[c >> 2] + '♠♥♦♣'[c & 3]; }

  // What one viewer may see. Hole cards of others only at showdown or when shown.
  function viewFor(t, viewerId, now) {
    const h = t.hand, me = t.players[viewerId];
    const seats = [];
    for (let i = 0; i < t.settings.maxPlayers; i++) {
      const id = t.seats[i];
      if (!id) { seats.push(null); continue; }
      const p = t.players[id], ps = h && h.ps[i] && h.ps[i].id === id ? h.ps[i] : null;
      let cards = null;
      if (ps) {
        const open = id === viewerId || (h.reveal && !ps.folded) || h.shown[i];
        cards = open ? ps.cards : ps.folded ? [] : [-1, -1];
      }
      seats.push({
        id: p.pub, name: p.name, stack: p.stack, connected: p.connected, sittingOut: p.sittingOut, bank: Math.round(p.bank),
        inHand: !!ps, bet: ps ? ps.bet : 0, folded: ps ? ps.folded : false, allin: ps ? ps.allin : false, last: ps ? ps.last : '',
        cards, shown: !!(h && h.shown[i] && ps), total: ps ? ps.total : 0, won: h && h.results && h.results.won[i] || 0, startStack: ps ? ps.start : p.stack,
      });
    }
    let hand = null;
    if (h) {
      hand = {
        no: h.no, button: h.button, sbSeat: h.sbSeat, bbSeat: h.bbSeat, board: h.board, street: h.street, phase: h.phase,
        toAct: h.toAct, deadline: h.deadline, turnAt: h.turnAt, pot: potTotal(h), bets: h.seats.reduce((s, x) => s + h.ps[x].bet, 0),
        curBet: h.curBet, bb: h.bb, results: h.results, nextAt: h.nextAt,
        actions: h.actions.map((x) => ({ street: x.street, name: nm(t, h.ps[x.seat].id), text: x.text, auto: x.auto })),
      };
      if (h.results) hand.results = Object.assign({}, h.results, { hands: Object.fromEntries(Object.entries(h.results.hands).filter(([s]) => h.reveal || h.shown[s])) });
    }
    const mySeat = me ? me.seat : -1;
    const ledger = Object.values(t.players).map((p) => {
      const inPot = p.seat >= 0 && h && h.phase !== 'done' && h.ps[p.seat] ? h.ps[p.seat].total : 0;
      return { id: p.pub, name: p.name, seat: p.seat, stack: p.stack, inPot, buyIn: p.buyIn, net: p.stack + inPot - p.buyIn, connected: p.connected };
    });
    return {
      now, settings: t.settings, blinds: t.blinds, hostId: t.players[t.hostId] ? t.players[t.hostId].pub : '', started: t.started, paused: t.paused, handNo: t.handNo,
      levelEndsAt: t.settings.levelMins && t.started ? (t.clock.since != null ? t.clock.since : now) + ((t.blinds.level + 1) * t.settings.levelMins * 60000 - t.clock.ms) : 0,
      seats, hand, me: me ? { id: me.pub, name: me.name, seat: mySeat, stack: me.stack, sittingOut: me.sittingOut, bank: Math.round(me.bank) } : null,
      legal: mySeat >= 0 ? legal(t, mySeat) : null, canRebuy: !!(me && mySeat >= 0 && t.settings.rebuys && me.stack < t.blinds.bb && !inHand(t, mySeat)),
      ledger, log: t.log.slice(-120), chat: t.chat.slice(-80).map((c) => ({ at: c.at, name: c.name, text: c.text, mine: c.id === viewerId })), canStart: canStart(t),
    };
  }
  function chat(t, id, text) {
    const p = t.players[id];
    text = String(text || '').trim().slice(0, 300);
    if (!p || !text) return 'Empty message.';
    t.chat.push({ at: Date.now(), id, name: p.name, text });
    if (t.chat.length > 200) t.chat.splice(0, t.chat.length - 200);
    return null;
  }

  function byPub(t, pub) { const p = Object.values(t.players).find((x) => x.pub === pub); return p ? p.id : null; }

  const api = {
    RANKS, STREETS, MAX_SEATS, DEFAULTS, eval5, bestHand, handName, cardStr, niceRound, blindsAt, cleanSettings, buildPots,
    createTable, setRandom, join, sit, stand, rebuy, setStack, kick, setSittingOut, updateSettings, startGame, startHand, legal, act,
    tick, setPaused, showCards, chat, viewFor, canStart, eligibleSeats, byPub,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof self !== 'undefined' ? self : this);
