// Scene objects are flat records with stable IDs. Array order is the paint order.
function sameItem(a, b) {
  if (!a || !b) return a === b;
  return Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => a[key] === b[key]);
}

export function sameScene(a, b) {
  return a.length === b.length && a.every((item, i) => sameItem(item, b[i]));
}

export function reconcile(base, local, remote) {
  const index = items => new Map(items.map(item => [item.id, item]));
  const original = index(base);
  const mine = index(local);
  const theirs = index(remote);
  const shared = new Set(base.filter(item => mine.has(item.id) && theirs.has(item.id)).map(item => item.id));
  const sharedOrder = items => items.filter(item => shared.has(item.id)).map(item => item.id).join('|');
  const reordered = sharedOrder(local) !== sharedOrder(base);
  const primary = reordered ? local : remote;
  const secondary = reordered ? remote : local;
  const primaryIds = new Set(primary.map(item => item.id));

  // Insert secondary-only layers beside their nearest surviving neighbor.
  const following = new Map();
  let previous = null;
  for (const item of secondary) {
    if (primaryIds.has(item.id)) previous = item.id;
    else {
      if (!following.has(previous)) following.set(previous, []);
      following.get(previous).push(item.id);
    }
  }
  const unanchored = following.get(null) || [];
  const hasNeighbors = secondary.some(item => primaryIds.has(item.id));
  const order = hasNeighbors ? [...unanchored] : [];
  for (const item of primary) {
    order.push(item.id, ...(following.get(item.id) || []));
  }

  if (!hasNeighbors) order.push(...unanchored);

  const items = [];
  let copies = 0;
  for (const id of order) {
    const before = original.get(id);
    const left = mine.get(id);
    const right = theirs.get(id);
    // An unchanged layer follows the change (including deletion) made elsewhere.
    if (sameItem(left, right) || sameItem(right, before)) {
      if (left) items.push(left);
    } else if (sameItem(left, before) || !left || !right) {
      // A simultaneous edit and deletion retains the edited copy.
      const retained = sameItem(left, before) ? right : (left || right);
      if (retained) items.push(retained);
    } else {
      const merged = {...right};
      let conflict = false;
      for (const key of Object.keys(left)) {
        if (left[key] === before?.[key]) continue;
        if (right[key] !== before?.[key] && right[key] !== left[key]) conflict = true;
        merged[key] = left[key];
      }
      if (conflict) {
        items.push(right, {...left, id: crypto.randomUUID(), x: left.x + 16, y: left.y + 16});
        copies++;
      } else items.push(merged);
    }
  }
  return {items, copies};
}
