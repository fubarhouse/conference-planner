import { describe, it, expect } from 'vitest';
import { orderTasks } from '../plannerTasks.js';

const ids = (list) => list.map((t) => t.id);

describe('orderTasks', () => {
  it("filters to open tasks with filter 'open'", () => {
    const tasks = [
      { id: 'a', done: false },
      { id: 'b', done: true },
    ];
    expect(ids(orderTasks(tasks, 'open'))).toEqual(['a']);
  });

  it("filters to done tasks with filter 'done'", () => {
    const tasks = [
      { id: 'a', done: false },
      { id: 'b', done: true },
    ];
    expect(ids(orderTasks(tasks, 'done'))).toEqual(['b']);
  });

  it('keeps all tasks but sorts open before done', () => {
    const tasks = [
      { id: 'done1', done: true },
      { id: 'open1', done: false, priority: 'normal' },
    ];
    expect(ids(orderTasks(tasks, 'all'))).toEqual(['open1', 'done1']);
  });

  it('sorts open tasks by priority (urgent → high → normal → low)', () => {
    const tasks = [
      { id: 'low', done: false, priority: 'low' },
      { id: 'urgent', done: false, priority: 'urgent' },
      { id: 'normal', done: false, priority: 'normal' },
      { id: 'high', done: false, priority: 'high' },
    ];
    expect(ids(orderTasks(tasks, 'all'))).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('breaks priority ties by due date, undated last', () => {
    const tasks = [
      { id: 'late', done: false, priority: 'high', dueDate: '2025-03-01' },
      { id: 'none', done: false, priority: 'high' },
      { id: 'early', done: false, priority: 'high', dueDate: '2025-01-01' },
    ];
    expect(ids(orderTasks(tasks, 'all'))).toEqual(['early', 'late', 'none']);
  });

  it('treats an unknown priority as normal', () => {
    const tasks = [
      { id: 'weird', done: false, priority: 'zzz' },
      { id: 'high', done: false, priority: 'high' },
      { id: 'low', done: false, priority: 'low' },
    ];
    // 'zzz' → order 2 (normal), so between high(1) and low(3)
    expect(ids(orderTasks(tasks, 'all'))).toEqual(['high', 'weird', 'low']);
  });
});
