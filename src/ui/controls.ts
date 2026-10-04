import type { Settings, ViewMode } from '../settings';

export type UpdateFn = (patch: Partial<Settings>) => void;

/** A control bound to one or more settings; `sync` pulls the current values into the DOM. */
export type Control = {
  root: HTMLElement;
  sync: (settings: Settings) => void;
  views?: ViewMode[];
};

type NumericKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];
type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];
type StringKey = {
  [K in keyof Settings]: Settings[K] extends string ? K : never;
}[keyof Settings];

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

export function rangeControl(
  key: NumericKey,
  label: string,
  options: { min: number; max: number; step?: number; format: (value: number, settings: Settings) => string },
  update: UpdateFn,
  views?: ViewMode[]
): Control {
  const root = el('label', 'field field-range');
  const head = el('span', 'field-head');
  const name = el('span', 'field-label', label);
  const output = el('output', 'field-value');
  head.append(name, output);
  const input = el('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step ?? 1);
  root.append(head, input);
  let current: Settings | null = null;

  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (current) {
      output.textContent = options.format(value, current);
    }
    update({ [key]: value } as Partial<Settings>);
  });

  return {
    root,
    views,
    sync(settings) {
      current = settings;
      const value = settings[key];
      if (Number(input.value) !== value) {
        input.value = String(value);
      }
      output.textContent = options.format(value, settings);
    },
  };
}

export function numberControl(
  key: NumericKey,
  label: string,
  options: { min?: number; max?: number; step?: number; integer?: boolean; suffix?: string },
  update: UpdateFn,
  views?: ViewMode[]
): Control {
  const root = el('label', 'field field-number');
  const name = el('span', 'field-label', label);
  const input = el('input');
  input.type = 'number';
  // iOS numeric/decimal keypads have no minus key: signed fields keep the default keyboard.
  if (options.min === undefined || options.min >= 0) {
    input.inputMode = options.integer ? 'numeric' : 'decimal';
  }
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  input.step = String(options.step ?? 'any');
  root.append(name);
  if (options.suffix) {
    const wrap = el('span', 'input-suffix');
    wrap.append(input, el('span', 'suffix', options.suffix));
    root.append(wrap);
  } else {
    root.append(input);
  }

  // Commit on change (blur / enter / spinner), not every keystroke: most of these restart the view.
  input.addEventListener('change', () => {
    let value = Number(input.value);
    if (!Number.isFinite(value) || input.value === '') {
      return;
    }
    if (options.integer) value = Math.round(value);
    if (options.min !== undefined) value = Math.max(options.min, value);
    if (options.max !== undefined) value = Math.min(options.max, value);
    input.value = String(value);
    update({ [key]: value } as Partial<Settings>);
  });

  return {
    root,
    views,
    sync(settings) {
      if (document.activeElement !== input) {
        input.value = String(settings[key]);
      }
    },
  };
}

export function segmentedControl<K extends StringKey | NumericKey>(
  key: K,
  label: string,
  choices: { value: Settings[K]; label: string }[],
  update: UpdateFn,
  views?: ViewMode[]
): Control {
  const root = el('div', 'field');
  const name = el('span', 'field-label', label);
  const group = el('div', 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const buttons = choices.map((choice) => {
    const button = el('button', '', choice.label);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => update({ [key]: choice.value } as Partial<Settings>));
    group.append(button);
    return { button, value: choice.value };
  });
  root.append(name, group);

  return {
    root,
    views,
    sync(settings) {
      for (const { button, value } of buttons) {
        button.setAttribute('aria-checked', String(settings[key] === value));
      }
    },
  };
}

export function toggleControl(
  key: BooleanKey,
  label: string,
  update: UpdateFn,
  views?: ViewMode[],
  hint?: string
): Control {
  const root = el('label', 'field field-toggle');
  const text = el('span', 'field-text');
  text.append(el('span', 'field-label', label));
  if (hint) {
    text.append(el('span', 'field-hint', hint));
  }
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => update({ [key]: input.checked } as Partial<Settings>));
  root.append(text, input);
  return {
    root,
    views,
    sync(settings) {
      input.checked = settings[key];
    },
  };
}

export function selectControl(
  key: StringKey,
  label: string,
  choices: { value: string; label: string }[],
  update: UpdateFn,
  views?: ViewMode[]
): Control {
  const root = el('label', 'field');
  const name = el('span', 'field-label', label);
  const select = el('select');
  select.id = nextId('select');
  for (const choice of choices) {
    const option = el('option', '', choice.label);
    option.value = choice.value;
    select.append(option);
  }
  select.addEventListener('change', () => update({ [key]: select.value } as Partial<Settings>));
  root.append(name, select);
  return {
    root,
    views,
    sync(settings) {
      select.value = String(settings[key]);
    },
  };
}

export function rowControl(children: Control[], views?: ViewMode[]): Control {
  const root = el('div', 'field-row');
  children.forEach((child) => root.append(child.root));
  return {
    root,
    views,
    sync(settings) {
      children.forEach((child) => child.sync(settings));
    },
  };
}

export function sectionControl(title: string, children: Control[], views?: ViewMode[], open = true): Control {
  const root = el('details', 'section');
  root.open = open;
  const summary = el('summary', '', title);
  const body = el('div', 'section-body');
  children.forEach((child) => body.append(child.root));
  root.append(summary, body);
  return {
    root,
    views,
    sync(settings) {
      for (const child of children) {
        child.root.hidden = !!child.views && !child.views.includes(settings.view);
        child.sync(settings);
      }
    },
  };
}
