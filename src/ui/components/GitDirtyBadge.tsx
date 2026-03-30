interface GitDirtyBadgeProps {
  count: number;
  className?: string;
}

export function GitDirtyBadge(props: GitDirtyBadgeProps) {
  if (props.count <= 0) {
    return null;
  }
  const title = `${String(props.count)} uncommitted ${props.count === 1 ? "file" : "files"}`;
  return (
    <span className={props.className ?? "git-dirty-badge"} title={title} aria-label={title}>
      {props.count > 99 ? "99+" : String(props.count)}
    </span>
  );
}
