import { DocumentRow, Project, WPPost } from "../shared/types";

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function projectToDoc(project: Project): DocumentRow {
  return {
    wp_id: null,
    doc_type: "project",
    project_slug: project.slug,
    project_title: project.title,
    project_type: project["project-type"],
    title: project.title,
    slug: project["project-slug"] ?? project.slug,
    permalink: null,
    excerpt: project["description-short"] ?? "",
    content: project["description-long"] ?? null,
    authors: JSON.stringify([project.author].filter(Boolean)),
    author_bios: JSON.stringify([]),
    tags: JSON.stringify(project.tags ?? []),
    image_url: project["og-image"] ?? project["project-product-image"] ?? null,
  };
}

export function postToDoc(post: WPPost, project: Project): DocumentRow {
  const rawExcerpt =
    post.excerpt && post.excerpt.length > 0
      ? post.excerpt
      : post.metadata?.description?.[0] ?? '';

  return {
    wp_id: post.id_post,
    doc_type: "post",
    project_slug: project.slug,
    project_title: project.title,
    project_type: project["project-type"],
    title: post.title,
    slug: post.slug,
    permalink: post.permalink ?? null,
    excerpt: stripHtml(rawExcerpt),
    content: stripHtml(post.content),
    authors: JSON.stringify(post.credits?.autores?.map((a) => a.name) ?? []),
    author_bios: JSON.stringify(
      post.credits?.autores?.map((a) => a.description) ?? [],
    ),
    tags:
      post.tags === false
        ? JSON.stringify([])
        : JSON.stringify(post.tags?.map((t) => t.name) ?? []),
    image_url: post.image ? post.image[0] : null,
  };
}
