/**
 * A folder setting as a person reads it: under the profile, from there (`Videos\Razorcat`);
 * elsewhere, as it is.
 */
export function folderLabel(setting: string): string {
  const profile = /^%USERPROFILE%\\/i;
  return profile.test(setting) ? setting.replace(profile, "") : setting;
}
