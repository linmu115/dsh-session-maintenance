import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(url: string): string {
  if (url.startsWith("#") || url.startsWith("/") || /^(?:https?|mailto):/iu.test(url)) return url;
  return "";
}

/** Static Markdown only: raw HTML is discarded, images never load, and unsafe URL schemes are removed. */
export function SafeMarkdown(props: { readonly children: string }) {
  return <div className="safe-markdown" data-testid="safe-static-markdown">
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => safeUrl(url)}
      components={{
        a: ({ children, href }) => href === undefined || href.length === 0
          ? <span className="markdown-blocked-link">{children}</span>
          : <a href={href} rel="noopener noreferrer">{children}</a>,
        img: ({ alt }) => <span className="markdown-image-placeholder">[图片：{alt ?? "无说明"}]</span>,
      }}
    >{props.children}</Markdown>
  </div>;
}
