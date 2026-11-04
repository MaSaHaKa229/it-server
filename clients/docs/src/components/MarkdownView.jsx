import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const DOC_HREF = /^doc:(\d+)$/;

/**
 * Отображение текста документа (Markdown).
 * Ссылки вида [текст](doc:123) превращаются во внутренние ссылки на документы.
 * links — список существующих связанных документов; если передан,
 * ссылки на отсутствующие документы помечаются как битые.
 */
export default function MarkdownView({ content, links = null }) {
  const known = useMemo(
    () => (links ? new Map(links.map((l) => [String(l.id), l])) : null),
    [links]
  );

  const components = useMemo(
    () => ({
      a({ href = '', children }) {
        const m = href.match(DOC_HREF);
        if (m) {
          const target = known?.get(m[1]);
          if (known && !target) {
            return (
              <span className="doc-link broken" title="Документ не найден или удалён">
                {children}
              </span>
            );
          }
          return (
            <Link className="doc-link" to={`/documents/${m[1]}`} title={target?.title}>
              {children}
            </Link>
          );
        }
        return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
      },
    }),
    [known]
  );

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => (DOC_HREF.test(url) ? url : defaultUrlTransform(url))}
        components={components}
      >
        {content?.trim() ? content : '*Текст документа отсутствует*'}
      </ReactMarkdown>
    </div>
  );
}
