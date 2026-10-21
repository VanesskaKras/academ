// pdf.js у Node бере DOMMatrix/Path2D з пакета @napi-rs/canvas. У бандлі функції Vercel
// його немає (pdf.js підвантажує його динамічним require, і збирач цього не бачить), а
// pdf.mjs створює `new DOMMatrix()` одразу при імпорті — тож /api/pdf-pages падав ще до
// першого рядка обробника (FUNCTION_INVOCATION_FAILED, "DOMMatrix is not defined").
// Нам потрібне лише читання тексту PDF, не рендер, тож досить простої 2D-матриці.
// Цей модуль має імпортуватись ДО pdf.js (порядок import = порядок виконання).

class DOMMatrix2D {
  constructor(init) {
    let m = [1, 0, 0, 1, 0, 0];
    if (Array.isArray(init) || ArrayBuffer.isView(init)) m = init.length >= 6 ? Array.from(init).slice(0, 6) : m;
    else if (init && typeof init === "object" && "a" in init) m = [init.a, init.b, init.c, init.d, init.e, init.f];
    [this.a, this.b, this.c, this.d, this.e, this.f] = m.map(Number);
  }

  get is2D() { return true; }

  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  // this = this × other
  multiplySelf(other) {
    const m = other instanceof DOMMatrix2D ? other : new DOMMatrix2D(other);
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
    return this;
  }

  // this = other × this
  preMultiplySelf(other) {
    const r = new DOMMatrix2D(other).multiplySelf(this);
    [this.a, this.b, this.c, this.d, this.e, this.f] = [r.a, r.b, r.c, r.d, r.e, r.f];
    return this;
  }

  multiply(other) { return this.clone().multiplySelf(other); }
  translateSelf(tx = 0, ty = 0) { return this.multiplySelf([1, 0, 0, 1, tx, ty]); }
  translate(tx, ty) { return this.clone().translateSelf(tx, ty); }
  scaleSelf(sx = 1, sy = sx) { return this.multiplySelf([sx, 0, 0, sy, 0, 0]); }
  scale(sx, sy) { return this.clone().scaleSelf(sx, sy); }

  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    [this.a, this.b, this.c, this.d, this.e, this.f] = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
    return this;
  }

  inverse() { return this.clone().invertSelf(); }
  clone() { return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]); }
  transformPoint(p = {}) {
    const x = p.x ?? 0, y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

// Контури потрібні лише для рендеру — для читання тексту достатньо "порожнього" об'єкта
class Path2DStub {
  addPath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  rect() {}
  closePath() {}
}

if (typeof globalThis.DOMMatrix === "undefined") globalThis.DOMMatrix = DOMMatrix2D;
if (typeof globalThis.Path2D === "undefined") globalThis.Path2D = Path2DStub;
