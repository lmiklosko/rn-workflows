declare module 'xcode' {
  interface BuildConfiguration {
    name: string;
    buildSettings: Record<string, string | undefined>;
  }
  interface XcodeProject {
    parseSync(): XcodeProject;
    writeSync(): string;
    getFirstTarget(): { uuid: string; firstTarget: { name: string; buildConfigurationList: string } };
    pbxXCConfigurationList(): Record<string, { buildConfigurations: { value: string }[] } | string>;
    pbxXCBuildConfigurationSection(): Record<string, BuildConfiguration | string>;
  }
  export function project(path: string): XcodeProject;
}
