import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { bootstrapDiscoveryText as discoveryText } from '../i18n/bootstrapDiscovery';
import { bootstrapJourneyText as journey } from '../i18n/bootstrapJourney';
import { shellText } from '../i18n/consoleShell';
import { FULLWEB_LANGUAGE_OPTIONS, setFullWebLanguage, useFullWebLanguage } from '../i18n/fullweb';
import logo from '../assets/brand/cpamp-logo-horizontal-color.svg?inline';
import logoOnDark from '../assets/brand/cpamp-logo-horizontal-on-dark.svg?inline';
import { FullWebIcon } from './FullWebIcon';
import {
  BootstrapTransportClient,
  BootstrapTransportError,
  FreshOperation,
  Handoff,
} from './bootstrapTransport';

import { FreshSetupWizard } from './FreshSetupWizard';
const UpgradeAuthenticationEntry = lazy(() => import('./UpgradeAuthenticationEntry').then(
  (module) => ({ default: module.UpgradeAuthenticationEntry })
));
export interface FreshBootstrapPageProps {
  handoff: Handoff | null;
  transport: BootstrapTransportClient;
}

type BootPhase = 'no_handoff' | 'connecting' | 'ready' | 'init_error';

interface ActionFeedback {
  tone: 'danger' | 'warn' | 'info' | 'success';
  title: string;
  detail: string;
}

// Public discovery never confers write authority. Non-Fresh statuses only
// enter either the existing-Admin gate or host intervention, never Fresh claim.
type DiscoveryGuidance = ActionFeedback & {
  flow: 'fresh' | 'host' | 'ownership' | 'upgrade';
  retryable?: true;
};
function publicDiscoveryGuidance(payload: unknown, language: string): DiscoveryGuidance | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (value.contract_version !== 'cpamp.phase4-01.discovery.v1') return null;
  if (
    value.status === 'fresh_claim_required' &&
    value.mode === 'fresh' &&
    value.auth_entry === 'fresh_claim' &&
    value.reason === 'fresh_claim_required' &&
    value.authentication_required === true
  ) {
    return {
      tone: 'info',
      flow: 'fresh',
      title: discoveryText('freshGuidanceTitle', language),
      detail: discoveryText('freshGuidanceDetail', language),
    };
  }
  if (
    value.status === 'unsupported_upgrade' &&
    value.mode === 'unsupported_upgrade' &&
    value.auth_entry === 'admin_session' &&
    value.reason === 'qualification_unavailable' &&
    value.authentication_required === true
  ) {
    return {
      tone: 'warn',
      flow: 'upgrade',
      title: discoveryText('upgradeGuidanceTitle', language),
      detail: discoveryText('upgradeGuidanceDetail', language),
    };
  }
  if (
    value.status === 'recovery_required' &&
    value.mode === 'recovery' &&
    value.auth_entry === 'host_intervention' &&
    value.reason === 'source_ownership_unavailable' &&
    value.authentication_required === false
  ) {
    return {
      tone: 'warn',
      flow: 'ownership',
      retryable: true,
      title: discoveryText('ownershipGuidanceTitle', language),
      detail: discoveryText('ownershipGuidanceDetail', language),
    };
  }
  if (
    value.status === 'recovery_required' &&
    value.mode === 'recovery' &&
    value.auth_entry === 'host_intervention' &&
    value.reason === 'recovery_host_intervention' &&
    value.authentication_required === false
  ) {
    return {
      tone: 'warn',
      flow: 'host',
      title: discoveryText('recoveryGuidanceTitle', language),
      detail: discoveryText('recoveryGuidanceDetail', language),
    };
  }
  if (
    value.status === 'unavailable' &&
    (value.mode === undefined || value.mode === null) &&
    value.auth_entry === 'unavailable' &&
    value.reason === 'observation_unavailable' &&
    value.authentication_required === false
  ) {
    return {
      tone: 'warn',
      flow: 'host',
      title: discoveryText('unavailableGuidanceTitle', language),
      retryable: true,
      detail: discoveryText('unavailableGuidanceDetail', language),
    };
  }
  return null;
}

function describeBootstrapError(
  err: unknown,
  stage: 'start' | 'generate' | 'commit' | 'refresh'
): ActionFeedback {
  if (err instanceof BootstrapTransportError) {
    if (err.kind === 'transport') {
      return {
        tone: 'warn',
        title: '网络连接异常（Bootstrap Transport Unavailable）',
        detail:
          stage === 'commit'
            ? '提交结果尚未确认，当前密钥与幂等提交标识（commitId）已保留在内存中。请检查网络或服务状态后点击“同步服务端状态”；确认服务端仍未初始化后才可重试。请勿刷新页面或更换密钥。'
            : stage === 'start'
              ? '无法连接至 Manager Bootstrap 服务端。您可尝试重新连接一次；若服务端已消费本次一次性 Claim Token 并返回 HTTP 401，请在宿主机重新执行 cpa-manager-plus initialize 获取新的 Handoff 链接。'
              : '无法连接至 Manager Bootstrap 服务端，请确认本地受控容器或服务进程正在运行后重试。',
      };
    }
    if (err.kind === 'rejected' || err.kind === 'authority') {
      return {
        tone: 'danger',
        title: 'Bootstrap 授权已失效或被拒绝（HTTP 401）',
        detail:
          stage === 'start'
            ? '一次性认领令牌（Claim Token）已被消费、过期，或被更新的初始化代际（Claim Generation）取代。请在宿主机重新执行 cpa-manager-plus initialize 获取最新 Handoff 链接。'
            : '当前 Bootstrap 会话授权已失效，或该操作在当前阶段已关闭。请点击“同步服务端状态”检查最新进度，或在宿主机重新执行初始化命令。',
      };
    }
    if (err.kind === 'mismatch') {
      return {
        tone: 'danger',
        title: '安装实例身份不匹配（Bootstrap Authority Mismatch）',
        detail:
          '服务端返回的 FreshOperation 身份（admissionId / installationId / generation / operationId）与 Handoff 凭证不一致，已按 Fail-Closed 策略中止操作。',
      };
    }
    if (err.kind === 'bad_request') {
      return {
        tone: 'danger',
        title: '请求参数未通过服务端校验（HTTP 400）',
        detail:
          '管理员密钥格式、字节长度或字符复杂度不符合服务端安全要求，请检查密钥规则或使用“一键生成”重新生成。',
      };
    }
    if (err.kind === 'conflict') {
      return {
        tone: 'warn',
        title: '操作状态冲突（HTTP 409）',
        detail:
          '服务端 FreshOperation 状态已发生变更（例如管理员已完成初始化或正在使用不同幂等标识提交）。请点击“同步服务端状态”获取最新状态。',
      };
    }
    return {
      tone: 'danger',
      title: `服务端暂时不可用${err.status ? `（HTTP ${err.status}）` : ''}`,
      detail: 'Bootstrap 服务端未能完成当前请求，请稍后重试或同步服务端状态。',
    };
  }
  return {
    tone: 'danger',
    title: '操作未能完成',
    detail: '发生未预期的客户端异常，请刷新服务端状态或重新获取 Handoff 链接。',
  };
}

export function FreshBootstrapPage({ handoff, transport }: FreshBootstrapPageProps) {
  const language = useFullWebLanguage();
  const [lightTheme, setLightTheme] = useState(true);
  const [phase, setPhase] = useState<BootPhase>(handoff ? 'connecting' : 'no_handoff');
  const [operation, setOperation] = useState<FreshOperation | null>(null);
  const [initError, setInitError] = useState<ActionFeedback | null>(null);
  const [initErrorKind, setInitErrorKind] = useState<string | null>(null);
  const [discoveryPayload, setDiscoveryPayload] = useState<unknown>(null);
  const [discoveryChecked, setDiscoveryChecked] = useState(false);
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const discoveryNote = publicDiscoveryGuidance(discoveryPayload, language);
  const startedRef = useRef(false);
  useEffect(() => {
    document.documentElement.classList.toggle('light', lightTheme);
    document.documentElement.setAttribute('data-theme', lightTheme ? 'white' : 'dark');
  }, [lightTheme]);
  const executeStart = useCallback(
    async (targetHandoff: Handoff) => {
      setPhase('connecting');
      setInitError(null);
      setInitErrorKind(null);
      try {
        const op = await transport.start(targetHandoff);
        setOperation(op);
        setPhase('ready');
      } catch (err) {
        const kind = err instanceof BootstrapTransportError ? err.kind : 'unknown';
        setInitErrorKind(kind);
        setInitError(describeBootstrapError(err, 'start'));
        setPhase('init_error');
      }
    },
    [transport]
  );

  useEffect(() => {
    if (handoff) return;
    let active = true;
    void fetch('/.well-known/cpamp-bootstrap', {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (response.status !== 200 && response.status !== 503) return null;
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object') return null;
        // Public discovery uses 200 for classified sources and 503 only for
        // unavailable. A mismatched HTTP status must never suggest Fresh setup.
        const unavailable = (payload as Record<string, unknown>).status === 'unavailable';
        return unavailable === (response.status === 503) ? payload : null;
      })
      .then((payload: unknown) => {
        if (!active) return;
        setDiscoveryPayload(payload);
        setDiscoveryChecked(true);
      })
      .catch(() => {
        // An unverified source must not receive Fresh setup guidance.
        if (active) setDiscoveryChecked(true);
      });
    return () => {
      active = false;
    };
  }, [handoff, discoveryAttempt]);

  useEffect(() => {
    // main.tsx remounts this boundary for each handoff/hash change. The
    // initial phase already covers a missing handoff without another render.
    if (!handoff) return;
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    // A newly mounted host handoff starts one external claim exchange. The
    // callback also owns the pending/error transitions used by manual retry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void executeStart(handoff);
  }, [handoff, executeStart]);

  if (!handoff && discoveryNote?.flow === 'upgrade') return <Suspense fallback={<></>}><UpgradeAuthenticationEntry /></Suspense>;

  return (
    <div className="bootstrap-shell" data-testid="fresh-bootstrap-shell">
      <header className="bootstrap-header">
        <div className="brand-group">
          <img className="journey-logo" src={lightTheme ? logo : logoOnDark} alt="CPAMP" />
          <span className="badge badge-indigo">
            {phase === 'no_handoff' && discoveryNote?.flow !== 'fresh'
              ? journey('preflight')
              : journey('preview')}
          </span>
          {operation && (
            <span
              className={`badge ${operation.productComplete ? 'badge-emerald' : 'badge-amber'}`}
              data-testid="gateway-status-badge"
            >
              {operation.productComplete ? shellText('ready') : journey('pending')}
            </span>
          )}
        </div>
        <div className="header-actions">
          <label className="bootstrap-language">
            <FullWebIcon name="globe" size={20} />
            <select
              data-testid="bootstrap-language-select"
              aria-label={discoveryText('languageLabel', language)}
              value={
                FULLWEB_LANGUAGE_OPTIONS.some((item) => item.value === language)
                  ? language
                  : language.startsWith('zh')
                    ? 'zh-CN'
                    : 'en'
              }
              onChange={(event) => setFullWebLanguage(event.target.value)}
            >
              {FULLWEB_LANGUAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-icon-only"
            onClick={() => setLightTheme((prev) => !prev)}
            aria-label={journey('theme')}
            title={journey('theme')}
          >
            <FullWebIcon name={lightTheme ? 'moon' : 'sun'} size={24} />
          </button>
          <span className="journey-version">v2</span>
        </div>
      </header>

      <main className="bootstrap-main">
        <div className={`wizard-container ${phase === 'ready' ? 'wizard-container-setup' : ''}`}>
          {phase === 'no_handoff' && (
            <section className="wizard-card" data-testid="bootstrap-no-handoff">
              <div className="wizard-card-header">
                <div className="wizard-step-tag">
                  <span>
                    {discoveryNote?.flow === 'fresh'
                      ? discoveryText('freshStepTag', language)
                      : discoveryNote?.flow === 'ownership'
                        ? discoveryText('ownershipStepTag', language)
                        : discoveryText('preflightStepTag', language)}
                  </span>
                </div>
                <h1 className="wizard-title">
                  {discoveryNote?.flow === 'ownership'
                    ? discoveryText('ownershipPageTitle', language)
                    : discoveryNote?.flow === 'host'
                      ? discoveryText('hostPageTitle', language)
                      : discoveryNote?.flow === 'fresh'
                        ? journey('claimRequired')
                        : discoveryChecked
                          ? discoveryText('unconfirmedPageTitle', language)
                          : discoveryText('pendingPageTitle', language)}
                </h1>
                <p className="wizard-desc">
                  {discoveryNote?.flow === 'ownership'
                    ? discoveryText('ownershipPageDesc', language)
                    : discoveryNote?.flow === 'host'
                      ? discoveryText('hostPageDesc', language)
                      : discoveryNote?.flow === 'fresh'
                        ? journey('claimRequiredHelp')
                        : discoveryText('unconfirmedPageDesc', language)}
                </p>
              </div>
              <div className="wizard-card-body">
                {discoveryNote && (
                  <div
                    className={`alert ${discoveryNote.tone === 'warn' ? 'alert-warn' : 'alert-info'}`}
                    data-testid="bootstrap-discovery-guidance"
                    role="status"
                  >
                    <div className="alert-content">
                      <div className="alert-title">{discoveryNote.title}</div>
                      <div className="alert-desc">{discoveryNote.detail}</div>
                    </div>
                  </div>
                )}

                {discoveryNote?.flow === 'ownership' ? (
                  <div className="legacy-ownership-steps" data-testid="legacy-ownership-instructions">
                    <div className="alert alert-info">
                      <div className="alert-content">
                        <div className="alert-title">
                          {discoveryText('ownershipUpgradeTitle', language)}
                        </div>
                        <div className="alert-desc">
                          {discoveryText('ownershipUpgradeDesc', language)}
                        </div>
                        <div className="code-block" data-testid="legacy-upgrade-preflight-command">
                          docker run --rm --entrypoint cpa-manager-plus -v &lt;1x_volume&gt;:/legacy:ro
                          -v &lt;v2_volume&gt;:/data seakee/cpa-manager-plus:2.0.0-beta.1 upgrade
                          preflight --legacy /legacy --source-version v1.14.10 --target-dir /data --json
                        </div>
                      </div>
                    </div>
                    <div className="alert alert-warn">
                      <div className="alert-content">
                        <div className="alert-title">
                          {discoveryText('ownershipChownTitle', language)}
                        </div>
                        <div className="alert-desc">
                          {discoveryText('ownershipChownDesc', language)}
                        </div>
                        <div className="code-block" data-testid="legacy-ownership-command">
                          chown 10002:10002 /data/usage.sqlite* /data/data.key
                        </div>
                      </div>
                    </div>
                  </div>
                ) : discoveryNote?.flow === 'host' ? (
                  <div className="alert alert-warn" data-testid="host-preflight-instructions">
                    <div className="alert-content">
                      <div className="alert-title">
                        {discoveryText('hostPreflightTitle', language)}
                      </div>
                      <div className="alert-desc">
                        {discoveryText('hostPreflightDesc', language)}
                      </div>
                      <div className="code-block" data-testid="host-preflight-command">
                        cpa-manager-plus legacy-preflight --db /path/to/usage.sqlite --summary
                      </div>
                    </div>
                  </div>
                ) : discoveryNote?.flow === 'fresh' ? (
                  <>
                    <div className="alert alert-warn">
                      <FullWebIcon name="alert" size={22} />
                      <div className="alert-content">
                        <div className="alert-title">
                          {discoveryText('freshHowTitle', language)}
                        </div>
                        <div className="alert-desc">
                          {discoveryText('freshHowPrefix', language)}
                          <code>#handoff=...</code>
                          {discoveryText('freshHowSuffix', language)}
                        </div>
                      </div>
                    </div>
                    <div className="code-block" data-testid="cli-handoff-command">
                      cpa-manager-plus initialize
                    </div>
                  </>
                ) : (
                  <div
                    className="alert alert-warn"
                    data-testid="bootstrap-discovery-unconfirmed"
                    role="status"
                  >
                    <div className="alert-content">
                      <div className="alert-title">
                        {discoveryChecked
                          ? discoveryText('unconfirmedCardTitle', language)
                          : discoveryText('pendingCardTitle', language)}
                      </div>
                      <div className="alert-desc">
                        {discoveryText('unconfirmedCardDesc', language)}
                      </div>
                    </div>
                  </div>
                )}
                {discoveryChecked && (!discoveryNote || discoveryNote.retryable) && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    data-testid="bootstrap-recheck-discovery"
                    onClick={() => {
                      // Reissue only the public read-only discovery GET.
                      // An unverified result never grants a claim or write authority.
                      setDiscoveryChecked(false);
                      setDiscoveryPayload(null);
                      setDiscoveryAttempt((attempt) => attempt + 1);
                    }}
                  >
                    {discoveryText('recheckButton', language)}
                  </button>
                )}
              </div>
            </section>
          )}

          {phase === 'connecting' && (
            <section className="wizard-card" data-testid="bootstrap-connecting">
              <div className="wizard-card-header">
                <div className="wizard-step-tag">
                  <span>{journey('claim')}</span>
                </div>
                <h1 className="wizard-title">
                  {handoff?.resume ? journey('resuming') : journey('claiming')}
                </h1>
                <p className="wizard-desc">{journey('claimingHelp')}</p>
              </div>
              <div className="wizard-card-body">
                <details>
                  <summary>{journey('diagnostics')}</summary>
                  <div className="info-card">
                    <div className="info-row">
                      <span className="info-key">授权模式</span>
                      <span className="info-val">
                        {handoff?.resume
                          ? 'Resume Session (GET operation)'
                          : 'Claim Exchange (POST claim/exchange)'}
                      </span>
                    </div>
                    {handoff && (
                      <>
                        <div className="info-row">
                          <span className="info-key">Operation ID</span>
                          <span className="info-val">{handoff.identity.operationId}</span>
                        </div>
                        <div className="info-row">
                          <span className="info-key">Installation / Gen</span>
                          <span className="info-val">
                            {handoff.identity.installationId} · {handoff.identity.generation}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </details>
              </div>
            </section>
          )}

          {phase === 'init_error' && initError && (
            <section className="wizard-card" data-testid="bootstrap-authority-error">
              <div className="wizard-card-header">
                <div className="wizard-step-tag">
                  <span>Bootstrap Authority Failed</span>
                </div>
                <h1 className="wizard-title">无法建立 Fresh Bootstrap 受控会话</h1>
                <p className="wizard-desc">
                  客户端已完成地址栏敏感片段清理，但与 Manager Bootstrap
                  后端交换或恢复授权时未通过验证。
                </p>
              </div>
              <div className="wizard-card-body">
                <div
                  className={`alert ${initError.tone === 'warn' ? 'alert-warn' : 'alert-danger'}`}
                  role="alert"
                >
                  <FullWebIcon name="alert" size={22} />
                  <div className="alert-content">
                    <div className="alert-title" data-testid="init-error-title">
                      {initError.title}
                    </div>
                    <div className="alert-desc" data-testid="init-error-detail">
                      {initError.detail}
                    </div>
                  </div>
                </div>

                {handoff && (
                  <div className="info-card">
                    <div className="info-row">
                      <span className="info-key">Operation ID</span>
                      <span className="info-val">{handoff.identity.operationId}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-key">Claim Generation</span>
                      <span className="info-val">#{handoff.claimGeneration}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-key">Handoff 模式</span>
                      <span className="info-val">{handoff.resume ? 'Resume' : 'Fresh Claim'}</span>
                    </div>
                  </div>
                )}

                <div className="code-block">cpa-manager-plus initialize</div>
              </div>
              {handoff && (initErrorKind === 'transport' || initErrorKind === 'unavailable') && (
                <div className="wizard-card-footer">
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    可尝试重新连接一次；若返回 HTTP 401（令牌已被消费），请在宿主机重新运行
                    cpa-manager-plus initialize 获取新 Handoff
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="retry-start-btn"
                    onClick={() => void executeStart(handoff)}
                  >
                    重试连接 Bootstrap 服务
                  </button>
                </div>
              )}
            </section>
          )}

          {phase === 'ready' && operation && (
            <FreshSetupWizard
              initialOperation={operation}
              transport={transport}
              onOperation={setOperation}
            />
          )}
        </div>
      </main>
      <footer className="journey-copyright">{journey('footer')}</footer>
    </div>
  );
}
