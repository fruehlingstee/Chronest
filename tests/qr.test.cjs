const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

test('vendored QR library matches the original pinned distribution', () => {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'qrcode.js'));
  assert.equal(createHash('sha384').update(bytes).digest('base64'), 'e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA');
});

function createQrTool() {
  const nodes = new Map();
  const pending = new Map();
  const rectangles = [];
  let timeoutId = 0;
  for (const id of ['qrCanvas', 'qrPlaceholder', 'qrMeta', 'downloadQr', 'copyQr', 'qrText', 'qrCharacterCount', 'qrLevel', 'qrSize', 'qrForeground', 'qrBackground', 'generateQr', 'resetQr', 'pasteQrText']) {
    nodes.set('#' + id, {
      value: '', textContent: '', hidden: false, disabled: true, isConnected: true,
      addEventListener(name, listener) { this['on' + name] = listener; }
    });
  }
  const canvas = nodes.get('#qrCanvas');
  const drawing = { fillStyle: '', fillRect(x, y, width, height) { rectangles.push({ x, y, width, height, color: this.fillStyle }); } };
  Object.defineProperty(canvas, 'width', { get() { return this.pixelWidth; }, set(width) { this.pixelWidth = width; rectangles.length = 0; } });
  canvas.getContext = () => drawing;
  const context = vm.createContext({
    TextEncoder, console, URL,
    data: { bookmarks: [], calculatorHistory: [] }, page: 'home',
    save() {}, render() {}, bind() {}, esc: value => String(value), navigator: {},
    document: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
    setTimeout(callback) { const id = ++timeoutId; pending.set(id, callback); return id; },
    clearTimeout(id) { pending.delete(id); }
  });
  context.window = context;
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor', 'qrcode.js'), 'utf8'), context);
  // 本番コードへテスト専用の公開口を追加せず、VM内だけで操作する。
  const source = fs.readFileSync(path.join(root, 'tools.js'), 'utf8').replace(/\}\)\(\);\s*$/, `globalThis.qrTest={drawQr,bindQr,setState(value){Object.assign(qrState,value);},state(){return qrState;}};})();`);
  vm.runInContext(source, context, { filename: 'tools.js' });
  return {
    nodes, canvas, rectangles, pending, context,
    setState: state => context.qrTest.setState(state),
    draw: () => context.qrTest.drawQr(),
    bind: () => context.qrTest.bindQr(),
    flush() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); }
  };
}

function canvasMatrix(tool) {
  const dark = tool.rectangles.slice(1);
  const cell = dark[0].width;
  const left = Math.min(...dark.map(rect => rect.x));
  const top = Math.min(...dark.map(rect => rect.y));
  const count = (Math.max(...dark.map(rect => rect.x)) - left) / cell + 1;
  const matrix = Array.from({ length: count }, () => Array(count).fill(false));
  for (const rect of dark) matrix[(rect.y - top) / cell][(rect.x - left) / cell] = true;
  return { matrix, cell, offset: left, count };
}

// version 1/2・誤り訂正Mの短文を、描画されたモジュールから独立に読み戻す。
// format情報でマスクを特定し、機能パターンを除いたジグザグのByteデータを復号する。
function readShortQr(matrix) {
  const n = matrix.length;
  assert.ok(n === 21 || n === 25, '短文テストはversion 1または2を使用');
  let format = 0;
  for (let bit = 0; bit < 15; bit++) {
    const row = bit < 6 ? bit : bit < 8 ? bit + 1 : n - 15 + bit;
    if (matrix[row][8]) format |= 1 << bit;
  }
  const info = (format ^ 0x5412) >> 10;
  assert.equal(info >> 3, 0, '誤り訂正Mは単一データブロック');
  const masks = [
    (r, c) => (r + c) % 2 === 0,
    r => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r * c) % 3 + (r + c) % 2) % 2 === 0
  ];
  const isFunction = (r, c) => r === 6 || c === 6 ||
    (r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8) ||
    (n === 25 && r >= 16 && r <= 20 && c >= 16 && c <= 20);
  const bits = [];
  let upwards = true;
  for (let column = n - 1; column > 0; column -= 2) {
    if (column === 6) column--;
    for (let step = 0; step < n; step++) {
      const row = upwards ? n - 1 - step : step;
      for (let side = 0; side < 2; side++) {
        const col = column - side;
        if (!isFunction(row, col)) bits.push(Number(matrix[row][col] !== masks[info & 7](row, col)));
      }
    }
    upwards = !upwards;
  }
  let cursor = 0;
  const read = width => { let value = 0; for (let i = 0; i < width; i++) value = value * 2 + bits[cursor++]; return value; };
  assert.equal(read(4), 4, 'Byteモード');
  const length = read(8);
  const bytes = Uint8Array.from({ length }, () => read(8));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

for (const text of ['日本語😀', ' \n日本😀 \n', 'e\u0301🙂', 'line 1\nline 2\t ', '  \n  ']) {
  test('canvas QR preserves exact UTF-8 payload: ' + JSON.stringify(text), () => {
    const tool = createQrTool();
    tool.setState({ text });
    assert.equal(tool.draw(), true);
    assert.equal(readShortQr(canvasMatrix(tool).matrix), text);
    assert.equal(tool.nodes.get('#downloadQr').disabled, false);
    assert.equal(tool.nodes.get('#copyQr').disabled, false);
  });
}

test('IME composition waits for confirmation and immediately prevents saving the old image', () => {
  const tool = createQrTool();
  tool.bind();
  const input = tool.nodes.get('#qrText');
  input.oncompositionstart();
  input.value = 'にほん';
  input.oninput({ target: input });
  assert.equal(tool.canvas.hidden, true);
  assert.equal(tool.nodes.get('#downloadQr').disabled, true);
  assert.equal(tool.nodes.get('#copyQr').disabled, true);
  assert.equal(tool.pending.size, 0);
  assert.equal(tool.draw(), false);
  input.value = '日本😀';
  input.oncompositionend();
  assert.equal(tool.pending.size, 1);
  assert.equal(tool.nodes.get('#downloadQr').disabled, true);
  tool.flush();
  assert.equal(readShortQr(canvasMatrix(tool).matrix), '日本😀');
});

test('ordinary input disables stale downloads until the newest QR is rendered', () => {
  const tool = createQrTool();
  tool.bind();
  const input = tool.nodes.get('#qrText');
  input.value = '更新後😀';
  input.oninput({ target: input });
  assert.equal(tool.nodes.get('#downloadQr').disabled, true);
  assert.equal(tool.canvas.hidden, true);
  tool.flush();
  assert.equal(readShortQr(canvasMatrix(tool).matrix), input.value);
  assert.equal(tool.nodes.get('#downloadQr').disabled, false);
});

test('empty and oversized UTF-8 input never leave a downloadable image', () => {
  const tool = createQrTool();
  assert.equal(tool.draw(), true);
  for (const text of ['', 'あ'.repeat(778), 'a'.repeat(2332)]) {
    tool.setState({ text });
    assert.equal(tool.draw(), false);
    assert.equal(tool.canvas.hidden, true);
    assert.equal(tool.nodes.get('#downloadQr').disabled, true);
    assert.equal(tool.nodes.get('#copyQr').disabled, true);
  }
  assert.match(tool.nodes.get('#qrPlaceholder').textContent, /長すぎ/);
});

test('low contrast and inverted colors cannot produce an unreadable downloadable image', () => {
  const tool = createQrTool();
  for (const colors of [
    { foreground: '#ffffff', background: '#ffffff' },
    { foreground: '#888888', background: '#aaaaaa' },
    { foreground: '#ffffff', background: '#000000' }
  ]) {
    tool.setState(colors);
    assert.equal(tool.draw(), false);
    assert.equal(tool.canvas.hidden, true);
    assert.equal(tool.nodes.get('#downloadQr').disabled, true);
    assert.equal(tool.nodes.get('#copyQr').disabled, true);
  }
});

test('PNG dimensions match selected size and dense codes retain three-pixel modules plus quiet zone', () => {
  const tool = createQrTool();
  for (const size of [200, 280, 360, 480, 640]) {
    tool.setState({ text: '日本😀', size });
    assert.equal(tool.draw(), true);
    assert.equal(tool.canvas.width, size);
    assert.equal(tool.canvas.height, size);
    const output = canvasMatrix(tool);
    assert.ok(output.cell >= 3);
    assert.ok(output.offset >= output.cell * 4);
  }
  tool.setState({ text: 'あ'.repeat(200), size: 200 });
  assert.equal(tool.draw(), true);
  const dense = canvasMatrix(tool);
  assert.ok(tool.canvas.width > 200);
  assert.ok(dense.cell >= 3);
  assert.ok(dense.offset >= dense.cell * 4);
  assert.match(tool.nodes.get('#qrMeta').textContent, /拡大/);
});
