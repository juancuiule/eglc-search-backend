import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Project, WPPost } from "../shared/types";

@Injectable()
export class WordPressService {
  private readonly logger = new Logger(WordPressService.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>("WP_BASE_URL");
  }

  async getProjects(): Promise<Project[]> {
    const res = await fetch(`${this.baseUrl}/wp-content/uploads/projects.json`);
    if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
    return res.json() as Promise<Project[]>;
  }

  async getProjectFromPost(post: WPPost): Promise<Project | null> {
    const projects = await this.getProjects();
    const project = projects.find((p) => p.slug === post.post_type);
    if (!project) {
      this.logger.warn(
        `No project found for post ${post.id_post} with type ${post.post_type}`,
      );
    }
    return project ?? null;
  }

  async getPosts(projectSlug: string): Promise<WPPost[]> {
    const res = await fetch(`${this.baseUrl}/wp-json/api/gato_get_posts/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: JSON.stringify({
          post_type: [projectSlug],
          posts_per_page: -1,
          paged: 1,
          meta_query: {
            relation: "OR",
            "0": { key: "lang", value: "es", compare: "=" },
            "1": { key: "lang", compare: "NOT EXISTS" },
          },
        }),
        reduced: false,
      }),
    });
    if (!res.ok)
      throw new Error(
        `Failed to fetch posts for ${projectSlug}: ${res.status}`,
      );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }

  async getSinglePost(wpId: number): Promise<WPPost | null> {
    const res = await fetch(`${this.baseUrl}/wp-json/api/gato_get_posts/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        args: JSON.stringify({
          // post_type: ['any'],
          posts_per_page: 1,
          paged: 1,
          post__in: [wpId],
          meta_query: {
            relation: 'OR',
            '0': { key: 'lang', value: 'es', compare: '=' },
            '1': { key: 'lang', compare: 'NOT EXISTS' },
          },
        }),
        reduced: false,
      }),
    });
    if (!res.ok) throw new Error(`Failed to fetch post ${wpId}: ${res.status}`);
    const data = await res.json();
    const posts: WPPost[] = Array.isArray(data) ? data : [];
    return posts[0] ?? null;
  }
}
