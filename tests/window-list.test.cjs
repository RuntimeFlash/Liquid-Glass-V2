const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const WindowType = { NORMAL: 0, DIALOG: 1, MODAL_DIALOG: 2, DESKTOP: 3, DOCK: 4, SPLASHSCREEN: 5, UTILITY: 6 };
const window = (wmClass, title = '', type = WindowType.NORMAL, extra = {}) => ({
  get_wm_class: () => wmClass, get_title: () => title, get_window_type: () => type, ...extra,
});
const app = (name, icon = 'app-icon') => ({
  get_name: () => name, get_app_info: () => ({ get_icon: () => ({ to_string: () => icon }) }),
});

function fixture(windows, getApp = () => null, getTracker) {
  const calls = { tracker: 0, apps: [], logs: [] };
  const tracker = { get_window_app(w) { calls.apps.push(w); return getApp(w); } };
  const { WindowListService } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/windowListService.js'), {
    Meta: { WindowType },
    Shell: { WindowTracker: { get_default() { calls.tracker++; return getTracker ? getTracker(tracker) : tracker; } } },
    global: { display: { list_all_windows: typeof windows === 'function' ? windows : () => windows } },
  });
  const service = new WindowListService({ log: text => calls.logs.push(text) });
  return { list: () => JSON.parse(service.ListWindows()), calls };
}

test('window list groups case-sensitive classes, caps unique titles and sorts by app name', () => {
  const windows = Array.from({ length: 11 }, (_, i) => window('Zebra', `title-${i}`));
  windows.push(window('Zebra', 'title-0'), window('zebra', 'lowercase'), window('Alpha'));
  const f = fixture(windows, w => w.get_wm_class() === 'Zebra' ? app('Aardvark') : null);
  assert.deepEqual(f.list(), [
    { wmClass: 'Zebra', appName: 'Aardvark', iconName: 'app-icon', titles: Array.from({ length: 8 }, (_, i) => `title-${i}`), count: 12, normal: true },
    { wmClass: 'Alpha', appName: '', iconName: '', titles: [], count: 1, normal: true },
    { wmClass: 'zebra', appName: '', iconName: '', titles: ['lowercase'], count: 1, normal: true },
  ]);
  assert.equal(f.calls.tracker, 1);
  assert.equal(f.calls.apps.length, 3);
});

test('window list excludes shell surfaces without looking up their applications', () => {
  const f = fixture([window(null), window(''), ...[3, 4, 5].map(type => window('Shell', '', type))]);
  assert.deepEqual(f.list(), []);
  assert.equal(f.calls.apps.length, 0);
});

test('window list marks normal and dialog groups but keeps utility windows', () => {
  const f = fixture([window('Utility', null, 6), window('Dialog', '', 1), window('Modal', '', 2),
    window('Mixed', '', 6), window('Mixed', '', 0)]);
  assert.deepEqual(f.list().map(e => [e.wmClass, e.normal, e.count]),
    [['Dialog', true, 1], ['Mixed', true, 2], ['Modal', true, 1], ['Utility', false, 1]]);
});

test('application lookups repeat while a name is missing and keep partially read metadata', () => {
  const windows = [window('Same'), window('Same'), window('Same'), window('Same')];
  let lookup = 0;
  const f = fixture(windows, () => {
    lookup++;
    if (lookup === 1) return null;
    if (lookup === 2) return app(null, 'old-icon');
    return { get_name: () => 'Named', get_app_info: () => null };
  });
  assert.deepEqual(f.list(), [{ wmClass: 'Same', appName: 'Named', iconName: 'old-icon', titles: [], count: 4, normal: true }]);
  assert.equal(lookup, 3);
});
