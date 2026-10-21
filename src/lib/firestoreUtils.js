export function serializeForFirestore(obj) {
  // Firestore не приймає undefined — замінюємо на null
  return JSON.parse(JSON.stringify(obj, (_, v) => v === undefined ? null : v));
}
