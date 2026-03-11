export class MinHeap {
  constructor(maxNodeCount) {
    if (!Number.isInteger(maxNodeCount) || maxNodeCount <= 0) {
      throw new Error('maxNodeCount must be a positive integer');
    }

    this.maxNodeCount = maxNodeCount;
    this.count = 0;
    this.costs = new Float64Array(Math.min(1024, maxNodeCount));
    this.nodeIndices = new Int32Array(Math.min(1024, maxNodeCount));
    this.positionLookup = new Int32Array(maxNodeCount);
    this.positionLookup.fill(-1);
  }

  get size() {
    return this.count;
  }

  isEmpty() {
    return this.count === 0;
  }

  push(nodeIndex, cost) {
    this._validateNodeIndex(nodeIndex);
    this._validateFiniteCost(cost, 'cost');

    const existingPosition = this.positionLookup[nodeIndex];
    if (existingPosition !== -1) {
      if (cost < this.costs[existingPosition]) {
        this.decreaseKey(nodeIndex, cost);
      }
      return;
    }

    this._ensureCapacity(this.count + 1);
    this.costs[this.count] = cost;
    this.nodeIndices[this.count] = nodeIndex;
    this.positionLookup[nodeIndex] = this.count;
    this._bubbleUp(this.count);
    this.count += 1;
  }

  pop() {
    const entry = { nodeIndex: -1, cost: 0 };
    if (!this.popInto(entry)) {
      return null;
    }
    return entry;
  }

  popInto(outEntry) {
    if (!outEntry || typeof outEntry !== 'object') {
      throw new Error('outEntry must be an object');
    }
    if (this.count === 0) {
      return false;
    }

    const rootNodeIndex = this.nodeIndices[0];
    const rootCost = this.costs[0];
    this.positionLookup[rootNodeIndex] = -1;

    const lastIndex = this.count - 1;
    this.count -= 1;

    if (this.count > 0) {
      const lastNodeIndex = this.nodeIndices[lastIndex];
      const lastCost = this.costs[lastIndex];
      this.nodeIndices[0] = lastNodeIndex;
      this.costs[0] = lastCost;
      this.positionLookup[lastNodeIndex] = 0;
      this._bubbleDown(0);
    }

    outEntry.nodeIndex = rootNodeIndex;
    outEntry.cost = rootCost;
    return true;
  }

  decreaseKey(nodeIndex, newCost) {
    this._validateNodeIndex(nodeIndex);
    this._validateFiniteCost(newCost, 'newCost');

    const position = this.positionLookup[nodeIndex];
    if (position === -1) {
      throw new Error(`node ${nodeIndex} is not in the heap`);
    }
    if (newCost > this.costs[position]) {
      throw new Error('decreaseKey cannot increase a key');
    }

    this.costs[position] = newCost;
    this._bubbleUp(position);
  }

  _bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent] <= this.costs[index]) {
        break;
      }
      this._swap(index, parent);
      index = parent;
    }
  }

  _bubbleDown(startIndex) {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < this.count && this.costs[left] < this.costs[smallest]) {
        smallest = left;
      }
      if (right < this.count && this.costs[right] < this.costs[smallest]) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }
      this._swap(index, smallest);
      index = smallest;
    }
  }

  _swap(a, b) {
    const nodeA = this.nodeIndices[a];
    const nodeB = this.nodeIndices[b];

    const costA = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = costA;

    this.nodeIndices[a] = nodeB;
    this.nodeIndices[b] = nodeA;
    this.positionLookup[nodeA] = b;
    this.positionLookup[nodeB] = a;
  }

  _ensureCapacity(minCapacity) {
    if (this.costs.length >= minCapacity) {
      return;
    }

    let nextCapacity = this.costs.length;
    while (nextCapacity < minCapacity) {
      nextCapacity *= 2;
    }

    const nextCosts = new Float64Array(nextCapacity);
    nextCosts.set(this.costs);
    this.costs = nextCosts;

    const nextNodeIndices = new Int32Array(nextCapacity);
    nextNodeIndices.set(this.nodeIndices);
    this.nodeIndices = nextNodeIndices;
  }

  _validateNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= this.maxNodeCount) {
      throw new Error(`nodeIndex out of range: ${nodeIndex}`);
    }
  }

  _validateFiniteCost(cost, fieldName) {
    if (!Number.isFinite(cost)) {
      throw new Error(`${fieldName} must be finite`);
    }
  }
}

export class DuplicateEntryMinHeap {
  constructor(maxNodeCount) {
    if (!Number.isInteger(maxNodeCount) || maxNodeCount <= 0) {
      throw new Error('maxNodeCount must be a positive integer');
    }

    this.maxNodeCount = maxNodeCount;
    this.count = 0;
    this.costs = new Float64Array(Math.min(1024, maxNodeCount));
    this.nodeIndices = new Int32Array(Math.min(1024, maxNodeCount));
  }

  get size() {
    return this.count;
  }

  isEmpty() {
    return this.count === 0;
  }

  push(nodeIndex, cost) {
    this._validateNodeIndex(nodeIndex);
    this._validateFiniteCost(cost, 'cost');

    this._ensureCapacity(this.count + 1);
    this.costs[this.count] = cost;
    this.nodeIndices[this.count] = nodeIndex;
    this._bubbleUp(this.count);
    this.count += 1;
  }

  popInto(outEntry) {
    if (!outEntry || typeof outEntry !== 'object') {
      throw new Error('outEntry must be an object');
    }
    if (this.count === 0) {
      return false;
    }

    const rootNodeIndex = this.nodeIndices[0];
    const rootCost = this.costs[0];

    const lastIndex = this.count - 1;
    this.count -= 1;

    if (this.count > 0) {
      this.nodeIndices[0] = this.nodeIndices[lastIndex];
      this.costs[0] = this.costs[lastIndex];
      this._bubbleDown(0);
    }

    outEntry.nodeIndex = rootNodeIndex;
    outEntry.cost = rootCost;
    return true;
  }

  _bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent] <= this.costs[index]) {
        break;
      }
      this._swap(index, parent);
      index = parent;
    }
  }

  _bubbleDown(startIndex) {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (left < this.count && this.costs[left] < this.costs[smallest]) {
        smallest = left;
      }
      if (right < this.count && this.costs[right] < this.costs[smallest]) {
        smallest = right;
      }

      if (smallest === index) {
        break;
      }
      this._swap(index, smallest);
      index = smallest;
    }
  }

  _swap(a, b) {
    const nodeA = this.nodeIndices[a];
    this.nodeIndices[a] = this.nodeIndices[b];
    this.nodeIndices[b] = nodeA;

    const costA = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = costA;
  }

  _ensureCapacity(minCapacity) {
    if (this.costs.length >= minCapacity) {
      return;
    }

    let nextCapacity = this.costs.length;
    while (nextCapacity < minCapacity) {
      nextCapacity *= 2;
    }

    const nextCosts = new Float64Array(nextCapacity);
    nextCosts.set(this.costs);
    this.costs = nextCosts;

    const nextNodeIndices = new Int32Array(nextCapacity);
    nextNodeIndices.set(this.nodeIndices);
    this.nodeIndices = nextNodeIndices;
  }

  _validateNodeIndex(nodeIndex) {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= this.maxNodeCount) {
      throw new Error(`nodeIndex out of range: ${nodeIndex}`);
    }
  }

  _validateFiniteCost(cost, fieldName) {
    if (!Number.isFinite(cost)) {
      throw new Error(`${fieldName} must be finite`);
    }
  }
}

export function runMinHeapSelfTest(seed = 0x12345678) {
  const maxCount = 1000;
  const heap = new MinHeap(maxCount);
  let randomState = seed >>> 0;

  const nextRandom = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 4294967296;
  };

  for (let i = 0; i < 1000; i += 1) {
    heap.push(i, nextRandom() * 1000);
  }

  for (let i = 0; i < 100; i += 1) {
    const nodeIndex = i * 3;
    if (nodeIndex < maxCount) {
      heap.decreaseKey(nodeIndex, i / 10);
    }
  }

  let lastCost = -Infinity;
  let poppedCount = 0;
  while (!heap.isEmpty()) {
    const entry = heap.pop();
    if (!entry) {
      throw new Error('heap pop returned null before heap was empty');
    }
    if (entry.cost < lastCost) {
      throw new Error(
        `heap order violation at item ${poppedCount}: ${entry.cost} < previous ${lastCost}`,
      );
    }
    lastCost = entry.cost;
    poppedCount += 1;
  }

  if (poppedCount !== maxCount) {
    throw new Error(`heap self-test popped ${poppedCount} items, expected ${maxCount}`);
  }
  return true;
}
