'use strict';
// Owns social; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createSocial = function createSocial(ctx) {
function order(h, t, ts) {
  if (ctx.restLocked(h) || t.bot !== h.bot || t.state !== 'fight') return;
  const cap = ctx.S.heroes[ctx.captainId()], [cx_, cy_] = cap ? [cap.x, cap.y] : ctx.spotOf(ctx.regionOf(ctx.captainId()));
  if (cap && !ctx.restLocked(cap)) { cap.bubble = {text: `⚔️ ${h.name}, take on ${t.title.slice(0, 24)}`, until: 2.6}; cap.cheer = .5; }
  ctx.S.fx.push({k: 'raven', x0: cx_, y0: cy_ - 50, x1: h.x, y1: h.y - 50, life: 1.3, max: 1.3});
  ctx.S.soc.orders = (ctx.S.soc.orders || 0) + 1;
  ctx.say(`📯 Captain sent ${ctx.nm(h)} to <b>${ctx.esc(t.title)}</b>`, ts, 'run' + t.id);
  h.act = null; h.task = t.id;                      // reserved: no hangout while the order is in the air
  ctx.laterHero(h, 1.3, () => { if (h.task !== t.id || t.state !== 'fight' || t.bot !== h.bot) return; h.bubble = {text: '❗ Acknowledged!', until: 1.4}; h.cheer = .5; });
  ctx.laterHero(h, 1.9, () => { if (h.task === t.id && t.state === 'fight' && t.bot === h.bot) ctx.engage(h, t); });
}

// ---------- social life ----------
// Idle heroes don't stand in a row: they hang out with the bots they actually work with (friends = bots linked
// through parent/child cards in the replay), visit the tavern, the market or the campfire, chat, cheer each other's
// wins and walk over to hand off a finished quest to whoever picks it up next. All walks go through route().
const HANGOUTS = [
  {region: 'inn', kind: 'tavern', icon: '🍺', th: 'visited the inn'}, {region: 'castle', kind: 'square', icon: '💬', th: 'chatted in the castle square'},
  {region: 'vault', kind: 'treasure', icon: '🪙', th: 'visited the vault'}, {region: 'port', kind: 'harbor', icon: '⚓', th: 'visited the harbor'},
  {region: 'forest', kind: 'campfire', icon: '🔥', th: 'gathered around the campfire'}];
const CHAT = {
  generic: ['Busy day', 'Seen the Captain?', 'Taking a break', 'Back soon', 'Ha!', 'Watch out for the volcano boss', 'Checking my tokens', '☕ Coffee, please'],
  warrior: ['Patched three files', 'Build passed!', 'On it'], ranger: ['Tests passed', 'Found another bug', 'Testing again'],
  paladin: ['A tough review', 'Two changes requested', 'LGTM 👍'], engineer: ['Deployed', 'CDN checked', 'Airship ready'],
  mage: ['Research ready', 'Reading docs'], sage: ['Drawing a new flow', 'Checking the numbers'], commander: ['Ready, everyone?', 'New plan ready']};
let FRIENDS = null;
function friends(bot) {
  if (!FRIENDS) {
    FRIENDS = {};
    const byId = Object.fromEntries(ctx.D.tasks.map(t => [t.id, t]));
    for (const t of ctx.D.tasks) for (const p of t.parents || []) {
      const a = t.bot, b = byId[p] && byId[p].bot;
      if (a && b && a !== b) { ((FRIENDS[a] ||= {})[b] = (FRIENDS[a][b] || 0) + 1); ((FRIENDS[b] ||= {})[a] = (FRIENDS[b][a] || 0) + 1); }
    }
  }
  return Object.entries(FRIENDS[bot] || {}).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
function free(h) { return !ctx.restLocked(h) && h.rest.phase !== 'returning' && !h.task && !h.sleep && h.down <= 0 && h.atk < 0 && h.cls !== 'commander'; }   // Captain stays at the war room
function hangSpot(region, k) {                       // circle formation inside the plaza, facing the centre
  const [x, y] = ctx.W.regions[region].spot, ring = Math.floor(k / 6), a = (k % 6) / 6 * 6.283 + ring * .5 + region.length * .7;
  return [x + Math.cos(a) * (50 + ring * 26), y + 30 + Math.sin(a) * (22 + ring * 10)];   // 6 per ring, rings grow outward
}
function startHangout(h, place, withWho = []) {
  if (ctx.restLocked(h)) return;
  const party = [h, ...withWho.filter(free)].slice(0, 4);
  const used = new Set(Object.values(ctx.S.heroes).filter(o => o.act && o.act.region === place.region).map(o => o.act.k));
  ctx.S.soc.hangouts = (ctx.S.soc.hangouts || 0) + 1; if (party.length > 1) ctx.S.soc.group = (ctx.S.soc.group || 0) + 1;
  party.forEach(m => {                               // smallest free spot in the circle: nobody stands on anybody
    let k = 0; while (used.has(k)) k++; used.add(k);
    m.act = {...place, until: 18 + Math.random() * 20, k};
    ctx.walkTo(m, place.region, ctx.placeEntity(m, place.region) || hangSpot(place.region, k));
  });
  if (party.length > 1) ctx.say(`${place.icon} ${party.map(ctx.nm).join(', ')} ${place.th}`, ctx.S.t, 'hang' + place.region, 900);
}
function social(dt) {
  const hs = Object.values(ctx.S.heroes);
  for (const h of hs) {
    h.cheer = Math.max(0, h.cheer - dt); h.talk = Math.max(0, h.talk - dt);
    if (!free(h) || h.path.length > 1) continue;
    if (h.act) {
      if ((h.act.until -= dt) <= 0) { h.act = null; h.idle = 6 + Math.random() * 14; ctx.goHome(h); continue; }
      // face the group centre and chat when someone else is here
      const mates = hs.filter(o => o !== h && o.act && o.act.region === h.act.region && o.path.length < 2);
      if (mates.length) {
        const cx_ = mates.reduce((s, o) => s + o.x, h.x) / (mates.length + 1); h.face = cx_ >= h.x ? 1 : -1;
        if (h.talk <= 0 && Math.random() < dt * .35) {
          const pool = [...(CHAT[h.cls] || []), ...CHAT.generic, ...recentNotes(h.bot)];
          h.bubble = {text: pool[Math.floor(Math.random() * pool.length)], until: 2.6}; h.talk = 3 + Math.random() * 3; ctx.S.soc.chats = (ctx.S.soc.chats || 0) + 1;
        }
      }
      continue;
    }
    if ((h.idle -= dt) > 0) continue;
    h.idle = 8 + Math.random() * 16;
    const fr = friends(h.bot).map(b => ctx.S.heroes[b]).filter(o => o && free(o) && !o.act);
    const place = HANGOUTS[Math.floor(Math.random() * HANGOUTS.length)];
    if (fr.length || Math.random() < .35) startHangout(h, place, fr.slice(0, 2));
  }
}
function recentNotes(bot) {
  return Object.values(ctx.S.tasks).filter(t => t.bot === bot && t.note).slice(-2).map(t => t.note.slice(0, 40));
}
function handOff(t) {                                // the finisher walks a quest scroll to whoever does the next card
  const from = t.bot && ctx.S.heroes[t.bot]; if (!from || ctx.restLocked(from)) return;
  const next = ctx.D.tasks.find(c => (c.parents || []).includes(t.id) && c.bot && c.bot !== t.bot);
  const to = next && ctx.S.heroes[next.bot]; if (!to || !free(to) || to.path.length > 1) return;   // only to someone standing still
  ctx.S.soc.handoffs = (ctx.S.soc.handoffs || 0) + 1;
  from.act = {region: to.region, kind: 'handoff', icon: '📜', until: 6, k: 0};
  ctx.walkTo(from, to.region, [to.x - 26, to.y]);
  from.bubble = {text: `📜 Handoff to ${to.name}`, until: 3};
  ctx.say(`📜 ${ctx.nm(from)} handed work to ${ctx.nm(to)}`, ctx.S.t, 'ho' + t.id);
}
function cheerAround(t) {
  for (const h of Object.values(ctx.S.heroes)) if (free(h) && Math.hypot(h.x - t.x, h.y - t.y) < 260) { h.cheer = .9; ctx.S.soc.cheers = (ctx.S.soc.cheers || 0) + 1; if (Math.random() < .4) h.bubble = {text: '🎉', until: 1.2}; }
}
return {
  get order(){return order}, set order(v){order=v},
  get HANGOUTS(){return HANGOUTS},
  get CHAT(){return CHAT},
  get FRIENDS(){return FRIENDS}, set FRIENDS(v){FRIENDS=v},
  get friends(){return friends}, set friends(v){friends=v},
  get free(){return free}, set free(v){free=v},
  get hangSpot(){return hangSpot}, set hangSpot(v){hangSpot=v},
  get startHangout(){return startHangout}, set startHangout(v){startHangout=v},
  get social(){return social}, set social(v){social=v},
  get recentNotes(){return recentNotes}, set recentNotes(v){recentNotes=v},
  get handOff(){return handOff}, set handOff(v){handOff=v},
  get cheerAround(){return cheerAround}, set cheerAround(v){cheerAround=v}
};
};
