declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        preload?: string;
        partition?: string;
        allowpopups?: string;
        nodeintegration?: string;
      },
      HTMLElement
    >;
  }
}
