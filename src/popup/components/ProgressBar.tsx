import React from 'react';

export type ProgressStatus = 'done' | 'active' | 'pending' | 'error';

interface ProgressItem {
  title: string;
  status: ProgressStatus;
}

interface ProgressBarProps {
  items: ProgressItem[];
  completed: number;
  total: number;
}

function StatusIcon({ status }: { status: ProgressStatus }) {
  switch (status) {
    case 'done':
      return <span className="progress-item__icon progress-item__icon--done">{'\u2713'}</span>;
    case 'active':
      return (
        <span className="progress-item__icon progress-item__icon--active">
          <span className="spinner" />
        </span>
      );
    case 'pending':
      return <span className="progress-item__icon progress-item__icon--pending">{'\u25cb'}</span>;
    case 'error':
      return <span className="progress-item__icon progress-item__icon--error">{'\u2717'}</span>;
  }
}

export function ProgressBar({ items, completed, total }: ProgressBarProps) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isInProgress = completed < total && completed > 0;

  return (
    <div className="progress-section">
      <div className="progress-percent">{percent}%</div>
      <div className="progress-bar">
        <div
          className={`progress-bar__fill${isInProgress ? ' progress-bar__fill--animated' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <ul className="progress-items">
        {items.map((item, i) => (
          <li key={i} className="progress-item">
            <StatusIcon status={item.status} />
            <span>{item.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
