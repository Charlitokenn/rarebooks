import { t } from 'fyo/utils/translation';
import { LanguageMap, SelectFileOptions } from 'utils/types';

/**
 * Platform abstraction for the window/shell/file actions the shared src/
 * code used to reach through the raw Electron `ipc` global. This is the
 * fyo/demux home AGENTS.md asks for (spec 0008 AC-8): every raw ipc call
 * this slice touches moved behind it, so both platforms share one call
 * site and only this file knows which platform it's on.
 *
 * Web is English-only this slice (spec 0008 AC-10), so getLanguageMap has
 * no web equivalent and the caller's English passthrough stands. Desktop
 * branches keep the exact ipc calls that used to sit at the call sites.
 */

export interface SelectedFile {
  name: string;
  filePath: string;
  success: boolean;
  canceled: boolean;
  data: Uint8Array;
}

export interface SavePathResult {
  canceled: boolean;
  filePath?: string;
}

export interface OpenPathResult {
  canceled: boolean;
  /** Mirrors Electron's OpenDialogReturnValue: defined, empty when canceled. */
  filePaths: string[];
}

export interface DeleteFileResult {
  error?: { code?: string; name: string; message: string; stack?: string };
}

export interface ShellDemuxBase {
  openLink(link: string): void;
  openExternalUrl(url: string): void;
  reloadWindow(): void;
  getLanguageMap(
    code: string
  ): Promise<{ success: boolean; message: string; languageMap?: LanguageMap }>;
  sendError(body: string): Promise<void>;
  showError(title: string, content: string): Promise<void>;
  selectFile(options: SelectFileOptions): Promise<SelectedFile>;
  getSaveFilePath(defaultPath: string): Promise<SavePathResult>;
  getOpenFilePath(title: string): Promise<OpenPathResult>;
  saveData(data: string, filePath: string): Promise<void>;
  showItemInFolder(filePath: string): void;
  deleteFile(filePath: string): Promise<DeleteFileResult>;
}

class ShellDemux implements ShellDemuxBase {
  #isElectron: boolean;
  constructor(isElectron: boolean) {
    this.#isElectron = isElectron;
  }

  openLink(link: string): void {
    if (!this.#isElectron) {
      window.open(link, '_blank', 'noopener');
      return;
    }
    ipc.openLink(link);
  }

  openExternalUrl(url: string): void {
    if (!this.#isElectron) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    ipc.openExternalUrl(url);
  }

  reloadWindow(): void {
    if (!this.#isElectron) {
      window.location.reload();
      return;
    }
    ipc.reloadWindow();
  }

  async getLanguageMap(code: string) {
    if (!this.#isElectron) {
      // English-only on Web this slice; a non-English code can't be served.
      return {
        success: false,
        message: 'Translations are not available on Web yet.',
      };
    }
    return await ipc.getLanguageMap(code);
  }

  async sendError(body: string): Promise<void> {
    if (!this.#isElectron) {
      // No main-process error sink in a browser; log so nothing is
      // silently dropped. The in-app toast still surfaces the error.
      // eslint-disable-next-line no-console
      console.warn('[shell.demux] error reported (no web sink):', body);
      return;
    }
    await ipc.sendError(body);
  }

  async showError(title: string, content: string): Promise<void> {
    if (!this.#isElectron) {
      // No native error dialog in a browser; the caller's in-app
      // showDialog path is the surface.
      // eslint-disable-next-line no-console
      console.error(`[shell.demux] ${title}: ${content}`);
      return;
    }
    await ipc.showError(title, content);
  }

  async selectFile(options: SelectFileOptions): Promise<SelectedFile> {
    if (!this.#isElectron) {
      // A DOM file input is the browser's dialog equivalent: pick a file,
      // read it as bytes, hand back the same shape Desktop's ipc returns.
      return await new Promise<SelectedFile>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        const extensions = options.filters?.flatMap((f) => f.extensions) ?? [];
        if (extensions.length) {
          input.accept = extensions.map((e) => `.${e}`).join(',');
        }

        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(canceledSelection());
            return;
          }
          const data = new Uint8Array(await file.arrayBuffer());
          resolve({
            name: file.name,
            filePath: file.name,
            success: true,
            canceled: false,
            data,
          });
        };

        // A dismissed picker fires no change event, so cancel is detected
        // when focus returns without a selection (browsers' common pattern).
        const onCancel = () => {
          window.removeEventListener('focus', onCancel);
          setTimeout(() => {
            if (!input.files?.length) {
              resolve(canceledSelection());
            }
          }, 300);
        };
        window.addEventListener('focus', onCancel);
        input.click();
      });
    }

    const response = await ipc.selectFile(options);
    return {
      name: response.name,
      filePath: response.filePath,
      success: response.success,
      canceled: response.canceled,
      data: new Uint8Array(response.data),
    };
  }

  async getSaveFilePath(defaultPath: string): Promise<SavePathResult> {
    if (!this.#isElectron) {
      // No path-addressable filesystem in a browser; a caller that needs
      // to write should use saveData, which downloads instead.
      return { canceled: true };
    }

    const response = await ipc.getSaveFilePath({
      title: t`Select folder`,
      defaultPath,
    });
    return { canceled: response.canceled, filePath: response.filePath };
  }

  async getOpenFilePath(title: string): Promise<OpenPathResult> {
    if (!this.#isElectron) {
      return { canceled: true, filePaths: [] };
    }

    const response = await ipc.getOpenFilePath({
      title,
      properties: ['openFile'],
      filters: [{ name: 'SQLite DB File', extensions: ['db'] }],
    });
    return { canceled: response.canceled, filePaths: response.filePaths };
  }

  async deleteFile(filePath: string): Promise<DeleteFileResult> {
    if (!this.#isElectron) {
      // A browser can't delete files off disk; the only caller is
      // Desktop's database selector.
      return {};
    }

    return await ipc.deleteFile(filePath);
  }

  async saveData(data: string, filePath: string): Promise<void> {
    if (!this.#isElectron) {
      // A browser "save" is a download; filePath (a path on disk) is not
      // meaningful, the name part of it becomes the download filename.
      const fileName = filePath.split(/[\\/]/).pop() ?? 'export';
      const url = URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }
    await ipc.saveData(data, filePath);
  }

  showItemInFolder(filePath: string): void {
    if (!this.#isElectron) {
      // Nothing to reveal in a browser; the download itself is the signal.
      return;
    }
    ipc.showItemInFolder(filePath);
  }
}

function canceledSelection(): SelectedFile {
  return {
    name: '',
    filePath: '',
    success: false,
    canceled: true,
    data: new Uint8Array(),
  };
}

/**
 * One ShellDemux per platform, memoized. Not held on the Fyo instance
 * because these actions are not doc/db/auth state, just window plumbing;
 * callers pass the (aliased) fyo's isElectron flag in.
 */
let webInstance: ShellDemux | undefined;
let electronInstance: ShellDemux | undefined;
export function getShellDemux(isElectron: boolean): ShellDemuxBase {
  if (isElectron) {
    return (electronInstance ??= new ShellDemux(true));
  }
  return (webInstance ??= new ShellDemux(false));
}
