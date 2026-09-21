/**
 * What this machine has told the plugin about its own instance identity.
 *
 * The plugin package must stay portable: it ships no instance id, no profile id and no
 * connection registration, because all three are facts about one machine. What it ships are
 * only the *default schema values* for `dshInstanceId` and `profileId`, and both defaults are
 * placeholders — `dsh-web` and `web` name nothing on any machine. Until a machine declares its
 * real identity in its own profile patch, a lease published under the placeholders would claim
 * an instance that does not exist, and an Engine targeting the real identity could never match
 * it. The profile id is part of that claim, not decoration: the handshake record carries both
 * fields and the Engine matches on both, so a real instance id under the placeholder profile
 * is still an identity the Engine cannot find.
 *
 * The judgement here is therefore deliberately about *refusing to take part in a takeover*,
 * never about refusing to run: an instance without a declared identity keeps working exactly
 * as before, it simply cannot be discovered or attached.
 */

/** The schema default that means "this machine has not declared an instance id". */
export const PLACEHOLDER_INSTANCE_ID = 'dsh-web';

/** The schema default that means "this machine has not declared a profile id". */
export const PLACEHOLDER_PROFILE_ID = 'web';

/** The one file an operator edits per machine. */
export const IDENTITY_DECLARATION_FILE = 'profiles/<profile>/cordis.patch.yml';

/** The configuration key an undeclared identity is missing, named as the operator sees it. */
export type MissingIdentityField = 'dshInstanceId' | 'profileId';

export interface IdentityDeclaration {
  readonly declared: boolean;
  readonly instanceId: string;
  /**
   * The resolved profile id, empty when none reached the plugin.
   *
   * Optional on purpose: the declaration rule is about two fields, but an existing caller that
   * only asked about the instance id stays type-compatible and keeps reading `instanceId`.
   */
  readonly profileId?: string;
  /** Present only when the identity is not declared. Logged, never thrown. */
  readonly message?: string;
}

/**
 * Read the declared identity out of the resolved configuration.
 *
 * Both `dshInstanceId` and `profileId` reach this plugin from the profile patch (machine-local)
 * or from the schema defaults (placeholders). For each field, the placeholder and an empty or
 * whitespace-only value all mean "not declared", and one undeclared field is enough to stand
 * down: the Engine matches an instance by the pair, so half a pair matches nothing.
 */
export function identityDeclaration(dshInstanceId: string, profileId: string): IdentityDeclaration {
  const instanceId = dshInstanceId.trim();
  const declaredProfileId = profileId.trim();
  const missing: MissingIdentityField[] = [];
  if (!isDeclared(instanceId, PLACEHOLDER_INSTANCE_ID)) missing.push('dshInstanceId');
  if (!isDeclared(declaredProfileId, PLACEHOLDER_PROFILE_ID)) missing.push('profileId');
  if (missing.length === 0) return { declared: true, instanceId, profileId: declaredProfileId };
  return { declared: false, instanceId, profileId: declaredProfileId, message: undeclaredIdentityMessage(missing) };
}

function isDeclared(value: string, placeholder: string): boolean {
  return value.length > 0 && value !== placeholder;
}

/** The operator-facing explanation: what is missing, where to declare it, and what still works. */
export function undeclaredIdentityMessage(missing: readonly MissingIdentityField[] = ['dshInstanceId', 'profileId']): string {
  return '[dsh-session-maintenance] 本机未声明实例身份'
    + `（${missing.join('、')} 仍为空或仍是占位默认值 dshInstanceId=${PLACEHOLDER_INSTANCE_ID} / profileId=${PLACEHOLDER_PROFILE_ID}）：`
    + '插件包不携带任何实例 ID 或 profile ID，'
    + `请在 ${IDENTITY_DECLARATION_FILE} 里的 id: session-maintenance 行补齐本机的这两项`
    + '（config.dshInstanceId 与 config.profileId，并同时给出 connectionId）。'
    + '在声明之前，本插件不发布实例握手、也不接受引擎接管；实例本身照常启动与使用。';
}
