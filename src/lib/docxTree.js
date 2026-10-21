// ─────────────────────────────────────────────
// docxTree.js — спільні правила обходу дерева document.xml для
// docxSurgicalEdit.js і docxAnnotations.js, щоб обидва бачили ОДНАКОВИЙ набір
// абзаців і тексту (інакше позиції з анотацій не збігаються з текстовою мапою).
//
// - Вміст mc:Fallback пропускається повністю: це дубль того самого напису/
//   фігури для старих версій Word, основне представлення — у mc:Choice. Без
//   цього текст кожного напису потрапляв у документ двічі.
// - Текст напису (w:txbxContent) — це окремі вкладені абзаци. До тексту
//   зовнішнього абзацу, що "тримає" фігуру, він не додається (раніше
//   getElementsByTagName("w:t") на зовнішньому абзаці захоплював і його,
//   і той самий текст ще раз ішов окремими вкладеними абзацами).
//
// Лише childNodes/parentNode/getElementsByTagName/tagName — працює однаково
// в браузерному DOM і в @xmldom/xmldom (воркер).
// ─────────────────────────────────────────────

export function isInFallback(node) {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.tagName === "mc:Fallback") return true;
  }
  return false;
}

// Чи належить вузол саме абзацу p (а не вкладеному абзацу напису всередині
// нього і не mc:Fallback-дублю).
export function belongsToParagraph(node, p) {
  for (let n = node.parentNode; n && n !== p; n = n.parentNode) {
    if (n.tagName === "w:p" || n.tagName === "mc:Fallback") return false;
  }
  return true;
}

// Усі абзаци документа в порядку документа, без mc:Fallback-дублів.
export function getBodyParagraphs(docXml) {
  return Array.from(docXml.getElementsByTagName("w:p")).filter(p => !isInFallback(p));
}

// Нащадки абзацу з тегом tag, що належать саме йому.
export function ownDescendants(p, tag) {
  return Array.from(p.getElementsByTagName(tag)).filter(el => belongsToParagraph(el, p));
}

// Найзовнішній предок із тегом tag (напр. таблиця, якщо абзац — у вкладеній таблиці).
export function outermostAncestor(node, tag) {
  let found = null;
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n.tagName === tag) found = n;
  }
  return found;
}

export function childByTag(el, tag) {
  return Array.from(el.childNodes).find(n => n.tagName === tag) || null;
}
