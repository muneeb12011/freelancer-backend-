// routes/tasks.js — Production complete
const router = require('express').Router();
const Task   = require('../models/Task');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── Shared activity helper ─────────────────────────
const addActivity = (task, text) => {
  task.activity.unshift({ text });
  if (task.activity.length > 100) task.activity = task.activity.slice(0, 100);
};

// ── GET /api/tasks/stats ───────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const uid  = req.user._id;
    const now  = new Date();
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const all = await Task.find({ user: uid }).lean();

    const overdue = all.filter(t =>
      !t.completed && t.status !== 'done' && t.deadline && new Date(t.deadline) < now
    );
    const doneThisWeek = all.filter(t =>
      t.completedAt && new Date(t.completedAt) >= weekStart
    );
    const createdThisWeek = all.filter(t =>
      new Date(t.createdAt) >= weekStart
    );
    const totalMins = all.reduce((s, t) => s + (t.trackedMinutes || 0), 0);

    // Velocity: tasks completed per day (last 14 days)
    const velocity = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      velocity.push({
        date:  ds,
        done:  all.filter(t => t.completedAt?.toISOString?.()?.split('T')[0] === ds || t.completedAt?.toString?.()?.startsWith(ds)).length,
        created: all.filter(t => t.createdAt?.toISOString?.()?.split('T')[0] === ds).length,
      });
    }

    res.json({
      counts: {
        total:      all.length,
        todo:       all.filter(t => t.status === 'todo').length,
        inProgress: all.filter(t => t.status === 'in-progress').length,
        review:     all.filter(t => t.status === 'review').length,
        done:       all.filter(t => t.status === 'done').length,
        overdue:    overdue.length,
        noDeadline: all.filter(t => !t.deadline && t.status !== 'done').length,
      },
      time: {
        totalMins,
        totalHours: (totalMins / 60).toFixed(1),
        estimatedHours: all.reduce((s, t) => s + (t.estimatedHours || 0), 0),
      },
      week: {
        done:    doneThisWeek.length,
        created: createdThisWeek.length,
      },
      velocity,
      sprints: [...new Set(all.map(t => t.sprint).filter(Boolean))],
    });
  } catch (err) { next(err); }
});

// ── GET /api/tasks ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user._id;
    const {
      status, priority, category, sprint, tag,
      clientId, overdue, hasDeadline, noDeadline,
      search, completed,
      sort = 'order,deadline,createdAt',
      limit = 300,
    } = req.query;

    const filter = { user: uid };
    if (status)   filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (sprint)   filter.sprint = sprint;
    if (tag)      filter.tags = tag;
    if (clientId) filter.$or = [{ client: clientId }, { clientId }];
    if (completed === 'false') filter.completed = false;
    if (completed === 'true')  filter.completed = true;

    if (overdue === 'true') {
      filter.completed  = false;
      filter.status     = { $ne: 'done' };
      filter.deadline   = { $lt: new Date() };
    }
    if (hasDeadline === 'true')  filter.deadline = { $exists: true, $ne: null };
    if (noDeadline === 'true')   filter.deadline = { $in: [null, undefined] };

    if (search) {
      const q = new RegExp(search, 'i');
      filter.$or = [{ title: q }, { description: q }, { tags: q }, { taskNumber: q }];
    }

    // Multi-field sort
    const sortObj = {};
    sort.split(',').forEach(f => {
      const dir = f.startsWith('-') ? -1 : 1;
      sortObj[f.replace('-', '')] = dir;
    });

    const tasks = await Task.find(filter)
      .sort({ order: 1, deadline: 1, createdAt: -1, ...sortObj })
      .limit(+limit)
      .populate('client', 'name')
      .lean();

    res.json({ tasks });
  } catch (err) { next(err); }
});

// ── POST /api/tasks ────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const task = new Task({ ...req.body, user: req.user._id });
    addActivity(task, 'Task created');
    await task.save();
    res.status(201).json({ task });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/:id ─────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id })
      .populate('client', 'name').populate('blockedBy', 'taskNumber title status').populate('blocks', 'taskNumber title status');
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json({ task });
  } catch (err) { next(err); }
});

// ── PATCH /api/tasks/:id ───────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });

    const prev   = task.toObject();
    const updates = { ...req.body };

    // Track status change
    if (updates.status && updates.status !== prev.status) {
      task.stateChangedAt = new Date();
      addActivity(task, `Status: ${prev.status} → ${updates.status}`);
      if (updates.status === 'done') {
        task.completedAt = new Date();
        task.completed   = true;
      }
    }
    if (updates.priority && updates.priority !== prev.priority) {
      addActivity(task, `Priority: ${prev.priority} → ${updates.priority}`);
    }
    if (updates.deadline && String(updates.deadline) !== String(prev.deadline)) {
      addActivity(task, `Deadline updated`);
    }

    // Apply updates
    Object.assign(task, updates);

    // Don't overwrite embedded arrays from a generic patch
    if (updates.subtasks) task.subtasks = updates.subtasks;

    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// ── DELETE /api/tasks/:id ──────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ── POST /api/tasks/:id/duplicate ─────────────────
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const src = await Task.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!src) return res.status(404).json({ error: 'Not found' });
    const { _id, taskNumber, createdAt, updatedAt, completedAt, stateChangedAt, activity, ...rest } = src;
    const dup = new Task({ ...rest, title: `${rest.title} (copy)`, status: 'todo', completed: false, user: req.user._id, subtasks: src.subtasks.map(s=>({...s,done:false,doneAt:null})), comments:[], activity:[] });
    addActivity(dup, `Duplicated from ${taskNumber}`);
    await dup.save();
    res.status(201).json({ task: dup });
  } catch (err) { next(err); }
});

// ── POST /api/tasks/reorder ────────────────────────
router.post('/reorder', async (req, res, next) => {
  try {
    await Promise.all(
      req.body.map(({ _id, order, status }) =>
        Task.findOneAndUpdate({ _id, user: req.user._id }, { order, ...(status ? { status } : {}) })
      )
    );
    res.json({ message: 'Reordered' });
  } catch (err) { next(err); }
});

// ═══ SUBTASKS ═══════════════════════════════════════

// POST /api/tasks/:id/subtasks
router.post('/:id/subtasks', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    const st = { title: req.body.title.trim(), order: task.subtasks.length };
    task.subtasks.push(st);
    addActivity(task, `Subtask added: "${st.title}"`);
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id/subtasks/:sid
router.patch('/:id/subtasks/:sid', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    const st = task.subtasks.id(req.params.sid);
    if (!st) return res.status(404).json({ error: 'Subtask not found' });
    if (req.body.done !== undefined) {
      st.done = req.body.done;
      st.doneAt = req.body.done ? new Date() : null;
      addActivity(task, `Subtask "${st.title}" ${req.body.done ? 'completed' : 'reopened'}`);
    }
    if (req.body.title) st.title = req.body.title;
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id/subtasks/:sid
router.delete('/:id/subtasks/:sid', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    const st = task.subtasks.id(req.params.sid);
    if (st) { addActivity(task, `Subtask removed: "${st.title}"`); }
    task.subtasks.pull(req.params.sid);
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// ═══ COMMENTS ═══════════════════════════════════════

// POST /api/tasks/:id/comments
router.post('/:id/comments', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    task.comments.unshift({ text: req.body.text.trim() });
    addActivity(task, 'Comment added');
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id/comments/:cid
router.delete('/:id/comments/:cid', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    task.comments.pull(req.params.cid);
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// ═══ TIME ENTRIES ════════════════════════════════════

// POST /api/tasks/:id/time
router.post('/:id/time', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    const mins = parseInt(req.body.minutes) || 0;
    if (mins < 1) return res.status(400).json({ error: 'Minutes must be > 0' });
    task.timeEntries.push({ minutes: mins, note: req.body.note || '' });
    task.trackedMinutes = task.timeEntries.reduce((s, e) => s + e.minutes, 0);
    addActivity(task, `${mins}m logged${req.body.note ? ': ' + req.body.note : ''}`);
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id/time/:eid
router.delete('/:id/time/:eid', async (req, res, next) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, user: req.user._id });
    if (!task) return res.status(404).json({ error: 'Not found' });
    task.timeEntries.pull(req.params.eid);
    task.trackedMinutes = task.timeEntries.reduce((s, e) => s + e.minutes, 0);
    await task.save();
    res.json({ task });
  } catch (err) { next(err); }
});

module.exports = router;