export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface Snapshot {
  id: string;
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  savedAt: number;
}
