"use client";

import { useMemo, useState, type DragEvent } from "react";
import { errorMessage } from "@/lib/api/client";
import { useOrg, useTasks, useUpdateTaskStatus } from "@/lib/api/hooks";
import type { Task, TaskStatus } from "@/lib/api/types";
import { daysUntil, formatDate } from "@/lib/ui/format";
import { PRIORITY_LABEL, TASK_BOARD_LABEL, TASK_STATUS_LABEL, workstreamLabel } from "@/lib/ui/labels";
import { AppIcon, EmptyState, ErrorState, SkeletonRows, useToast } from "@/components/eip/ui";
import { useEventId } from "@/components/eip/workspace";

const COLUMNS: TaskStatus[] = ["TODO", "IN_PROGRESS", "DONE"];
const BOARDS = ["ALL", "PLANNING", "OPERATIONS", "MEASUREMENT"] as const;
const PRIORITY_CLASS: Record<string, string> = { CRITICAL: "yüksek", HIGH: "yüksek", MEDIUM: "orta", LOW: "düşük" };

function TaskCard({ task, onMove, canMove, busy }: { task: Task; onMove: (s: TaskStatus) => void; canMove: boolean; busy: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const completed = task.status === "DONE";
  const days = task.dueDate ? daysUntil(task.dueDate) : null;
  const dueTone = completed || days === null ? "" : days < 0 ? "due-overdue" : days <= 3 ? "due-soon" : "";

  return (
    <article
      className={`task-card${completed ? " completed" : ""}${busy ? " task-busy" : ""}`}
      draggable={canMove}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="task-card-title">
        <div>
          <p>{workstreamLabel(task.workstream)}</p>
          <h3>
            {completed && (
              <span className="completed-check" aria-hidden="true">
                <AppIcon name="check" />
              </span>
            )}
            {task.title}
          </h3>
        </div>
        {canMove && (
          <button
            className="task-more-button"
            type="button"
            aria-label={`${task.title} durumunu değiştir`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <AppIcon name="more" />
          </button>
        )}
        {menuOpen && (
          <div className="task-status-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
            {COLUMNS.map((s) => (
              <button
                className={s === task.status ? "active" : ""}
                type="button"
                role="menuitem"
                key={s}
                onClick={() => {
                  setMenuOpen(false);
                  if (s !== task.status) onMove(s);
                }}
              >
                {TASK_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>
      {task.description && <p className="task-description">{task.description}</p>}
      <div className="task-card-meta">
        {task.priority && (
          <span className={`priority priority-${PRIORITY_CLASS[task.priority]}`}>
            <i aria-hidden="true" />
            {PRIORITY_LABEL[task.priority]}
          </span>
        )}
        <span className={dueTone}>
          <AppIcon name="calendar" />
          {task.dueDate ? formatDate(task.dueDate, true) : "Tarih yok"}
        </span>
      </div>
      <div className="task-card-footer">
        <span>{task.assigneeRole ?? "Sorumlu atanmadı"}</span>
        <span>{task.dependsOn?.length ?? 0} bağımlılık</span>
      </div>
    </article>
  );
}

export default function TaskBoardPage() {
  const eventId = useEventId();
  const toast = useToast();
  const { can } = useOrg();
  const tasks = useTasks(eventId);
  const move = useUpdateTaskStatus(eventId);
  const [board, setBoard] = useState<(typeof BOARDS)[number]>("ALL");
  const [column, setColumn] = useState<TaskStatus>("TODO");
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const canMove = can("task.update_status");

  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const visible = all.filter(
    (t) => (board === "ALL" || t.board === board) && t.title.toLocaleLowerCase("tr-TR").includes(search.toLocaleLowerCase("tr-TR")),
  );
  const byColumn = (s: TaskStatus) =>
    visible.filter((t) => t.status === s).sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));

  async function setStatus(task: Task, status: TaskStatus) {
    setMoving(task.id);
    try {
      await move.mutateAsync({ taskId: task.id, status });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setMoving(null);
    }
  }

  function onDrop(e: DragEvent, status: TaskStatus) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const task = all.find((t) => t.id === id);
    if (task && task.status !== status) void setStatus(task, status);
  }

  return (
    <section className="board-content">
      <div className="board-toolbar">
        <div className="segment-control" role="tablist" aria-label="Görev panosunu filtrele">
          {BOARDS.map((b) => (
            <button className={board === b ? "active" : ""} type="button" role="tab" aria-selected={board === b} key={b} onClick={() => setBoard(b)}>
              {b === "ALL" ? "Tümü" : TASK_BOARD_LABEL[b]}
            </button>
          ))}
        </div>
        <div className="board-toolbar-right">
          <label className="search-field">
            <span className="visually-hidden">Görev ara</span>
            <AppIcon name="search" />
            <input type="search" placeholder="Görev ara" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <span>{visible.length} görev</span>
        </div>
      </div>

      {tasks.isPending ? (
        <SkeletonRows rows={4} label="Görevler yükleniyor" />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState title="Henüz görev yok. Plan önerilerinden görev kartını uygulayarak başlayın." />
      ) : (
        <>
          <div className="mobile-column-switcher" aria-label="Görev durumu">
            {COLUMNS.map((s) => (
              <button className={column === s ? "active" : ""} type="button" key={s} onClick={() => setColumn(s)}>
                {TASK_STATUS_LABEL[s]} {byColumn(s).length}
              </button>
            ))}
          </div>
          <div className="task-board">
            {COLUMNS.map((s) => (
              <section
                className={`board-column${column === s ? " mobile-active" : ""}${dragOver === s ? " drag-over" : ""}`}
                key={s}
                onDragOver={(e) => {
                  if (!canMove) return;
                  e.preventDefault();
                  setDragOver(s);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => onDrop(e, s)}
              >
                <header>
                  <h2>{TASK_STATUS_LABEL[s]}</h2>
                  <span>{byColumn(s).length}</span>
                </header>
                <div className="task-list">
                  {byColumn(s).map((t) => (
                    <TaskCard task={t} key={t.id} canMove={canMove} busy={moving === t.id} onMove={(next) => setStatus(t, next)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
