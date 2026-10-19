import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {SURFACE_OPTIONS, APPEARANCE, LAYOUT, SPRING, OPTICS, LIGHTING, SHADOWS} from './advanced-model.js';
import {ADAPTIVE_SURFACES, TOP_BAR} from './model.js';
import {addPanelMenus} from './panel-menus.js';
import {Branch, ToggleBranch} from './branch.js';

function addNumbers(group, controls, specs, prefix = '', slider = true) {
  return new Map(specs.map(([key, title, min, max, step]) => [key,
    controls.number(group, title, [`${prefix}${key}`], min, max, step, '', { slider })]));
}

function addMotion(group, controls, surface) {
  const key = `enable-${surface}-animation`;
  const toggle = controls.toggle(group, 'Animations', key);
  const branch = new Branch(toggle);
  const morphToggle = branch.add(controls.toggle(group, 'Grow from the button', `${surface}-grow-from-button`,
    'The glass leaves the button as a drop and stretches into the menu'));
  // Spring constants and intervals mean their number; no slider.
  const morphBranch = new ToggleBranch(morphToggle, 2);
  morphBranch.add(controls.number(group, 'Morph speed', [`${surface}-morph-speed`], 0.1, 3, 0.1, '', {slider: false}), 0);
  for (const row of addNumbers(group, controls, SPRING, `${surface}-`, false).values()) morphBranch.add(row, 1);
  const updateMorph = () => {
    morphBranch.switch = controls.settings.get_boolean(`${surface}-grow-from-button`) ? 0 : 1;
  };
  const updateMotion = () => {
    const on = controls.settings.get_boolean(key);
    branch.enabled = on;
    morphBranch.enabled = on;
    updateMorph();
  };
  controls.watch([key], updateMotion);
  controls.watch([`${surface}-grow-from-button`], updateMorph);
  updateMotion();
}

function addOutline(group, controls, surface) {
  const key = `${surface}-outline-enabled`;
  const toggle = controls.toggle(group, 'Outline', key, 'A line along the visible edge of the glass, for seeing it better');
  const branch = new Branch(toggle);
  branch.add(controls.number(group, 'Outline width', [`${surface}-outline-width`], 0.5, 10, 0.5, '', { slider: true }));
  branch.add(controls.color(group, 'Outline color', [`${surface}-outline-color`]));
  controls.watch([key], () => { branch.enabled = controls.settings.get_boolean(key); });
}

function addLayout(group, controls, surface, appearance) {
  const rows = addNumbers(group, controls, LAYOUT[surface], `${surface}-`);
  if (surface === 'menu' || surface === 'panel-menu') {
    const key = `${surface}-match-quick-settings-height`;
    controls.toggle(group, 'Match quick settings height', key);
    controls.watch([key], () => { rows.get('scale').sensitive = !controls.settings.get_boolean(key); });
  }
  if (surface === 'top-bar') {
    controls.watch(['top-bar-style'], () => {
      const shown = controls.settings.get_value('top-bar-style').deep_unpack() !== 'off';
      for (const row of rows.values()) row.visible = shown;
    });
  }
}

function addSurface(page, controls, surface, title) {
  const group = controls.group(page, title);
  if (surface === 'top-bar') controls.choice(group, 'Style', TOP_BAR, 'The bar itself; menus have their own entries', false);


  const appearance = addNumbers(group, controls, APPEARANCE, `${surface}-`);
  controls.color(group, 'Tint', [`${surface}-tint-color`]);
  addOutline(group, controls, surface);
  addLayout(group, controls, surface, appearance);
  if (['menu', 'panel-menu', 'quick-settings'].includes(surface)) addMotion(group, controls, surface);
  if (surface === 'launcher') {
    const transition = controls.choice(group, 'Change to pinned items', [
      { title: 'Morph', patch: { 'launcher-pinned-transition': 'morph' } },
      { title: 'Ease', patch: { 'launcher-pinned-transition': 'tween' } },
    ], 'Ctrl+P shows the pinned items.', false);
    const morphBranch = new Branch(transition);
    morphBranch.add(controls.number(group, 'Spring response', ['launcher-spring-response'], 0, 3, 0.01,
      'How fast the springs respond to changes in the menu\'s size'));
    morphBranch.add(controls.number(group, 'Spring damping fraction', ['launcher-spring-damping-fraction'], 0, 5, 0.01,
      'How much the springs damp when they reach their target'));
    controls.watch(['launcher-pinned-transition'], () => {
      morphBranch.enabled = controls.settings.get_value('launcher-pinned-transition').deep_unpack() === 'morph';
    });
    const width = controls.number(group, 'Width', ['launcher-width'], 320, 1400, 10, 'Of the search field and its results', { slider: true });
    const height = controls.number(group, 'Pinned items height', ['launcher-pinned-height'], 240, 1200, 10, '', { slider: true });
    const iconSize = controls.number(group, 'Pinned icon size', ['launcher-pinned-icon-size'], 32, 96, 4,
      'Fewer, larger tiles in a narrow launcher; the tiles are spread evenly over the row', { slider: true });
  }
  if (ADAPTIVE_SURFACES.includes(surface)) {
    const key = `${surface}-enable-adaptive-text-color`;
    const toggle = controls.toggle(group, 'Adaptive color', key, 'Text and icons turn light or dark to stay readable on the glass');
    const branch = new Branch(toggle);
    branch.add(controls.number(group, 'Adaptive color interval (ms)', [`${surface}-sample-interval-ms`], 100, 2000, 50));
    const preferenceKey = `${surface}-adaptive-text-preference`;
    branch.add(controls.choice(group, 'Preferred text color', [
      { title: 'Automatic', patch: { [preferenceKey]: 'auto' } },
      { title: 'Light', patch: { [preferenceKey]: 'light' } },
      { title: 'Dark', patch: { [preferenceKey]: 'dark' } },
    ], 'Decides only when both colors are equally readable', false));
    controls.watch([key], () => { branch.enabled = controls.settings.get_boolean(key); });
  }
  return group;
}

function addRendering(page, controls) {
  const blur = controls.group(page, 'Blur');
  controls.choice(blur, 'Method', [
    { title: 'Gaussian', patch: { 'blur-method': 0 } },
    { title: 'Dual Kawase', patch: { 'blur-method': 1 } },
  ]);
  controls.choice(blur, 'Resolution', [
    { title: 'Half', patch: { 'glass-blur-downscale': 2 } },
    { title: 'Quarter', patch: { 'glass-blur-downscale': 4 } },
  ]);
  const groups = [blur];
  for (const [title, specs] of [['Optics', OPTICS], ['Lighting', LIGHTING], ['Shadows', SHADOWS]]) {
    const group = controls.group(page, title);
    addNumbers(group, controls, specs);
    if (specs === LIGHTING) {
      controls.toggle(group, 'Color from backdrop', 'glass-backdrop-highlights',
        'Light takes the color of what is behind the glass instead of white');
    }
    groups.push(group);
  }
  return groups;
}

export function buildAdvancedPreferences(pages, controls) {
  const selectorGroup = controls.group(pages.appearance, 'Individual effects');
  const selector = new Adw.ComboRow({
    title: 'Surface', selected: 0,
    model: Gtk.StringList.new(SURFACE_OPTIONS.map(([, title]) => title))
  });
  selectorGroup.add(selector);
  const surfaces = new Map();
  const effects = controls.group(pages.effects, 'Individual effects');
  controls.choice(effects, 'Top bar', TOP_BAR, 'The bar itself; menus have their own entries', false);
  for (const [surface, title, key, hint] of SURFACE_OPTIONS)
    if (key && surface !== 'application') controls.toggle(effects, title, key, hint ?? '');
  const groups = [selectorGroup, effects, addPanelMenus(pages.effects, controls),
    ...addRendering(pages.rendering, controls)];
  let visible = false;
  const refresh = () => {
    const index = selector.selected;
    if (visible && !surfaces.has(index)) {
      const [surface, title] = SURFACE_OPTIONS[index];
      surfaces.set(index, addSurface(pages.appearance, controls, surface, title));
    }
    for (const [i, group] of surfaces) group.visible = visible && i === index;
  };
  selector.connect('notify::selected', refresh);
  return show => {
    visible = show;
    for (const group of groups) group.visible = show;
    refresh();
  };
}
