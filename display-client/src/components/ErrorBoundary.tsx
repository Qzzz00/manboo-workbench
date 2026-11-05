import { Component, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  error?: Error;
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-card">
            <div className="error-boundary-icon">🛡️</div>
            <h2>出错了</h2>
            <p>应用遇到了意外问题，但你的数据是安全的。</p>
            <button type="button" onClick={this.handleReload}>
              重新加载
            </button>
            {this.state.error?.message && (
              <pre className="error-boundary-detail">{this.state.error.message}</pre>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
