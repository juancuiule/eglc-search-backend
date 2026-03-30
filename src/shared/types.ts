// ── WordPress API types ──────────────────────────────────────────────────────

export type ProjectType =
  | "book"
  | "podcast"
  | "collection"
  | "newsletter"
  | "post";

export interface Project {
  tags: string[];
  author: string;
  title: string;
  "short-title"?: string;
  "description-short": string;
  "description-long": string;
  "project-slug": string;
  slug: string;
  "project-type": ProjectType;
  "project-product-image"?: string;
  "og-image"?: string;
}

export interface WPAuthor {
  name: string;
  description: string;
}

export interface WPTag {
  term_id: number;
  name: string;
  slug: string;
}

export interface WPMetadata {
  link: string[];
  description: string[];
  project: string[];
}

export interface WPPost {
  id_post: number;
  status: boolean;
  post_status: "publish" | string;
  credits: { autores: WPAuthor[] };
  excerpt: string;
  title: string;
  slug: string;
  post_type: string;
  content?: string;
  permalink: string;
  image: [string, number, number, boolean] | null;
  tags: WPTag[] | false;
  metadata: WPMetadata;
}

// ── Database row types ───────────────────────────────────────────────────────

export interface DocumentRow {
  wp_id: number | null;
  doc_type: "project" | "post";
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string | null;
  excerpt: string;
  content: string | null;
  authors: string; // JSON: string[]
  author_bios: string; // JSON: string[]
  tags: string; // JSON: string[]
  image_url: string | null;
}

export interface DocumentDbRow extends DocumentRow {
  id: number;
  indexed_at: string;
}

// ── Index status ─────────────────────────────────────────────────────────────

export interface IndexStatus {
  state: "idle" | "running";
  lastIndexedAt: string | null;
  totalDocs?: number;
  progress: { current: number; total: number } | null;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: number;
  doc_type: "project" | "post";
  project_slug: string;
  project_title: string;
  project_type: string;
  title: string;
  slug: string;
  permalink: string;
  excerpt: string;
  authors: string;
  tags: string | null;
  image_url: string | null;
  rank: number;
  snippet_content: string;
  snippet_excerpt: string;
  matchedFields: string[];
  content?: string;
}
