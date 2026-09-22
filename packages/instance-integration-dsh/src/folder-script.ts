// Use the native Common Item Dialog on Windows PowerShell 5.1 as well as newer
// hosts. No PowerShell 7 installation or legacy shell-tree enumeration is needed.
export const FOLDER_PICKER_READY = 'DSH_VAULT_PICKER_READY';
const FOLDER_PICKER_TEMPLATE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshVaultFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IFileDialogEvents events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [ComImport, Guid("973510db-7d7f-452b-8975-74a85828d354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialogEvents {
    [PreserveSig] int OnFileOk(IFileDialog dialog);
    [PreserveSig] int OnFolderChanging(IFileDialog dialog, IShellItem folder);
    [PreserveSig] int OnFolderChange(IFileDialog dialog);
    [PreserveSig] int OnSelectionChange(IFileDialog dialog);
    [PreserveSig] int OnShareViolation(IFileDialog dialog, IShellItem item, out uint response);
    [PreserveSig] int OnTypeChange(IFileDialog dialog);
    [PreserveSig] int OnOverwrite(IFileDialog dialog, IShellItem item, out uint response);
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  class Events : IFileDialogEvents {
    bool ready;
    public int OnFolderChange(IFileDialog dialog) {
      if (!ready) { ready = true; Console.Error.WriteLine("${FOLDER_PICKER_READY}"); Console.Error.Flush(); }
      return 0;
    }
    public int OnFileOk(IFileDialog dialog) { return 0; }
    public int OnFolderChanging(IFileDialog dialog, IShellItem folder) { return 0; }
    public int OnSelectionChange(IFileDialog dialog) { return 0; }
    public int OnShareViolation(IFileDialog dialog, IShellItem item, out uint response) { response = 0; return 0; }
    public int OnTypeChange(IFileDialog dialog) { return 0; }
    public int OnOverwrite(IFileDialog dialog, IShellItem item, out uint response) { response = 0; return 0; }
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  public static string Pick() {
    IFileDialog dialog = (IFileDialog)new FileOpenDialog();
    uint cookie = 0;
    try {
      uint options; dialog.GetOptions(out options);
      // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | DONTADDTORECENT
      dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x2000000);
      dialog.SetTitle("__DSH_FOLDER_PICKER_TITLE__");
      dialog.SetOkButtonLabel("选择此文件夹");
      // Avoid restoring an unavailable last-used network folder from shell history.
      Guid iid = typeof(IShellItem).GUID;
      IShellItem initial;
      SHCreateItemFromParsingName(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), IntPtr.Zero, ref iid, out initial);
      try { dialog.SetFolder(initial); } finally { Marshal.ReleaseComObject(initial); }
      var events = new Events();
      dialog.Advise(events, out cookie);
      int result = dialog.Show(IntPtr.Zero);
      GC.KeepAlive(events);
      if (result == unchecked((int)0x800704C7)) return null;
      Marshal.ThrowExceptionForHR(result);
      IShellItem selected; dialog.GetResult(out selected);
      try {
        IntPtr path; selected.GetDisplayName(0x80058000, out path);
        try { return Marshal.PtrToStringUni(path); } finally { Marshal.FreeCoTaskMem(path); }
      } finally { Marshal.ReleaseComObject(selected); }
    } finally {
      if (cookie != 0) dialog.Unadvise(cookie);
      Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
@{ path = [DshVaultFolderPicker]::Pick() } | ConvertTo-Json -Compress
`;

export const VAULT_FOLDER_PICKER_TITLE = '选择已安装 Obsidian Bridge 的 Vault 文件夹';

/**
 * The helper is one program; only the caption differs per entry, so every caller
 * supplies its own title instead of keeping a second copy of the dialog code. The
 * title is stripped of quotes before it reaches the script and is never used to
 * evaluate the selected path.
 */
export function folderPickerScript(title: string): string {
  return FOLDER_PICKER_TEMPLATE.replace('__DSH_FOLDER_PICKER_TITLE__', title.replace(/["'`$\\]/gu, ''));
}

export const FOLDER_PICKER_SCRIPT = folderPickerScript(VAULT_FOLDER_PICKER_TITLE);
