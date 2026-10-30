// Nickname rules: shape + a profanity / impersonation filter. Normalises look-alike characters (leetspeak, separators)
// so "f.u.c.k", "sh1t" and "n1gger" are caught. Kept deliberately short; extend BLOCK / RESERVED as needed.
const NAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i' };
const BLOCK = [ // matched anywhere inside the (normalised) name
  'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard', 'twat', 'penis', 'vagina',
  'nigg', 'faggot', 'retard', 'tranny', 'chink', 'kike', 'wetback', 'beaner', 'rapist', 'molest', 'hitler', 'blowjob', 'handjob', 'dildo', 'killyourself', 'terrorist',
];
const TOKEN = ['fck', 'fag', 'rape', 'pedo', 'nazi', 'kkk', 'isis', 'jihad', 'porn', 'cum', 'jizz', 'anal', 'kys', 'coon', 'spic', 'gook', 'paki', 'wank', 'suicide'];
const SAFE = ['scunthorpe']; // innocent words that contain a blocked substring
// names that could be mistaken for staff / the project, or used to scam winners
const RESERVED = ['admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'official', 'owner', 'system', 'root', 'vwfest', 'vwfestofficial', '209madness', '209beats', 'guessthechart', 'giveaway', 'winner', 'null', 'undefined', 'anonymous'];
const norm = s => String(s).toLowerCase().replace(/[01345789@$!]/g, c => LEET[c]).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
// returns an error string, or null when the name is fine
function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'Nickname: 3–16 letters, numbers, _ . -';
  if (!/[A-Za-z]/.test(name)) return 'Nickname needs at least one letter.';
  const raw = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  if (RESERVED.includes(raw) || RESERVED.includes(n)) return 'That nickname is reserved. Pick another.';
  let flat = name.toLowerCase(); for (const w of SAFE) flat = flat.split(w).join('');
  const f = flat.replace(/[01345789@$!]/g, c => LEET[c]).replace(/[^a-z]/g, '');
  const fd = f.replace(/(.)\1+/g, '$1');
  const bad = BLOCK.some(w => { const nw = w.replace(/(.)\1+/g, '$1'); return f.includes(w) || fd.includes(nw); })
    || [name.toLowerCase(), ...name.toLowerCase().split(/[_.\-]+/), ...name.toLowerCase().split(/[_.\-0-9]+/)].some(t => { const x = t.replace(/[01345789@$!]/g, c => LEET[c]).replace(/[^a-z]/g, ''); return TOKEN.includes(x) || TOKEN.includes(x.replace(/(.)\1+/g, '$1')); });
  return bad ? 'Keep it friendly — pick a different nickname.' : null;
}
module.exports = { NAME_RE, checkName };
