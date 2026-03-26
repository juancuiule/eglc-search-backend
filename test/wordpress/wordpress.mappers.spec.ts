import { postToDoc, projectToDoc } from '../../src/wordpress/wordpress.mappers';
import { WPPost, Project } from '../../src/shared/types';

const mockProject: Project = {
  title: 'El libro',
  slug: 'el-libro',
  'project-slug': 'el-libro-slug',
  'project-type': 'book',
  author: 'Juan Pérez',
  tags: ['ciencia', 'ensayo'],
  'description-short': 'Descripción corta',
  'description-long': 'Descripción larga',
  'og-image': 'https://example.com/img.jpg',
};

const mockPost: WPPost = {
  id_post: 42,
  title: 'Capítulo 1',
  slug: 'capitulo-1',
  post_type: 'el-libro',
  excerpt: 'Un extracto',
  content: 'Contenido del capítulo',
  permalink: 'https://example.com/cap-1',
  image: ['https://example.com/cover.jpg', 800, 600, false],
  credits: { autores: [{ name: 'Ana García', description: 'Escritora' }] },
  tags: [{ term_id: 1, name: 'ficción', slug: 'ficcion' }],
};

describe('projectToDoc', () => {
  it('sets doc_type to project', () => {
    expect(projectToDoc(mockProject).doc_type).toBe('project');
  });

  it('sets wp_id to null', () => {
    expect(projectToDoc(mockProject).wp_id).toBeNull();
  });

  it('serializes tags as JSON array', () => {
    const doc = projectToDoc(mockProject);
    expect(JSON.parse(doc.tags)).toEqual(['ciencia', 'ensayo']);
  });

  it('uses og-image as image_url', () => {
    expect(projectToDoc(mockProject).image_url).toBe('https://example.com/img.jpg');
  });

  it('uses description-short as excerpt', () => {
    expect(projectToDoc(mockProject).excerpt).toBe('Descripción corta');
  });
});

describe('postToDoc', () => {
  it('sets doc_type to post', () => {
    expect(postToDoc(mockPost, mockProject).doc_type).toBe('post');
  });

  it('sets wp_id from id_post', () => {
    expect(postToDoc(mockPost, mockProject).wp_id).toBe(42);
  });

  it('serializes author names as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.authors)).toEqual(['Ana García']);
  });

  it('serializes author bios as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.author_bios)).toEqual(['Escritora']);
  });

  it('serializes tag names as JSON array', () => {
    const doc = postToDoc(mockPost, mockProject);
    expect(JSON.parse(doc.tags)).toEqual(['ficción']);
  });

  it('uses image[0] as image_url', () => {
    expect(postToDoc(mockPost, mockProject).image_url).toBe('https://example.com/cover.jpg');
  });

  it('defaults excerpt to empty string when missing', () => {
    const post = { ...mockPost, excerpt: undefined } as unknown as WPPost;
    expect(postToDoc(post, mockProject).excerpt).toBe('');
  });

  it('sets image_url to null when image is null', () => {
    const post = { ...mockPost, image: null };
    expect(postToDoc(post, mockProject).image_url).toBeNull();
  });
});
