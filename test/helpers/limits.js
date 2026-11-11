import assert from 'node:assert/strict';

const json = (x) => x?.toJSON?.() ?? x;
const T = { row: 1, button: 2, string: 3, user: 5, role: 6, mention: 7, channel: 8 };
const SELECTS = [T.string, T.user, T.role, T.mention, T.channel];

/** asserts a message payload ({content, components}) fits Discord's component limits; returns the raw rows */
export function assertDiscordLimits(payload, what = 'payload') {
  const at = (m) => `${what}: ${m}`;
  if (payload.content !== undefined) assert.ok(payload.content.length <= 2000, at(`content ${payload.content.length} > 2000`));
  const rows = (payload.components ?? []).map(json);
  assert.ok(rows.length <= 5, at(`${rows.length} rows > 5`));
  const ids = new Set();
  for (const row of rows) {
    assert.equal(row.type, T.row, at('top level must be action rows'));
    const cs = row.components.map(json);
    assert.ok(cs.length >= 1, at('empty row'));
    const hasSelect = cs.some((c) => SELECTS.includes(c.type));
    assert.ok(!hasSelect || cs.length === 1, at('a select must be alone in its row'));
    assert.ok(cs.length <= 5, at(`${cs.length} components in a row`));
    for (const c of cs) {
      if (c.type === T.button) {
        assert.ok(c.style === 5 ? c.url : c.custom_id, at('button needs custom_id (or url for link)'));
        if (c.label) assert.ok(c.label.length <= 80, at(`button label ${c.label.length} > 80: ${c.label}`));
        assert.ok(c.label || c.emoji, at('button without label or emoji'));
      } else assert.ok(SELECTS.includes(c.type), at(`unknown component type ${c.type}`));
      if (c.custom_id !== undefined) {
        assert.ok(c.custom_id.length >= 1 && c.custom_id.length <= 100, at(`custom_id length ${c.custom_id.length}`));
        assert.ok(!ids.has(c.custom_id), at(`duplicate custom_id ${c.custom_id}`));
        ids.add(c.custom_id);
      }
      if (!SELECTS.includes(c.type)) continue;
      if (c.placeholder) assert.ok(c.placeholder.length <= 150, at(`placeholder ${c.placeholder.length} > 150`));
      const min = c.min_values ?? 1, max = c.max_values ?? 1;
      assert.ok(min <= max && max <= 25, at(`${c.custom_id}: min ${min} / max ${max}`));
      if (c.type === T.string) {
        const opts = c.options ?? [];
        assert.ok(opts.length >= 1 && opts.length <= 25, at(`${c.custom_id}: ${opts.length} options`));
        assert.ok(max <= opts.length, at(`${c.custom_id}: max_values ${max} > ${opts.length} options`));
        assert.equal(new Set(opts.map((o) => o.value)).size, opts.length, at(`${c.custom_id}: duplicate option values`));
        for (const o of opts) {
          assert.ok(o.label.length >= 1 && o.label.length <= 100, at(`option label ${o.label.length}`));
          assert.ok(o.value.length >= 1 && o.value.length <= 100, at('option value length'));
          if (o.description) assert.ok(o.description.length <= 100, at('option description > 100'));
        }
        const defaults = opts.filter((o) => o.default);
        assert.ok(defaults.length <= max, at(`${c.custom_id}: ${defaults.length} defaults > max_values ${max}`));
      } else {
        // entity selects: default_values must fit max_values
        assert.ok((c.default_values ?? []).length <= max, at(`${c.custom_id}: ${c.default_values.length} defaults > max_values ${max}`));
      }
    }
  }
  return rows;
}
