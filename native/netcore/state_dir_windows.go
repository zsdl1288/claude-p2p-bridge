//go:build windows

package netcore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// prepareStateDir gives tsnet the rights it needs to secure its state directory.
// MkdirAll's Unix mode does not set a Windows ACL: an inherited Modify grant
// omits WRITE_OWNER, which Tailscale needs when setting the owner and group.
// An existing directory's owner can update its DACL without elevation. Only
// accept the current user or the token's enabled Administrators group as owner;
// never take ownership of another account's directory or follow reparse points.
func prepareStateDir(stateDir string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fmt.Errorf("read Windows user for private network state: %w", err)
	}
	stateDir = filepath.Clean(stateDir)
	if filepath.Dir(stateDir) == stateDir {
		return fmt.Errorf("private network state must use a dedicated directory, not a volume root: %s", stateDir)
	}

	// Hold each ancestor without FILE_SHARE_DELETE while creating/checking its
	// child. ACL changes use the final handle, not a path that can be replaced.
	var ancestors []string
	for path := stateDir; ; path = filepath.Dir(path) {
		ancestors = append(ancestors, path)
		if filepath.Dir(path) == path {
			break
		}
	}
	var directory windows.Handle
	var directoryInfo windows.ByHandleFileInformation
	for i := len(ancestors) - 1; i >= 0; i-- {
		path := ancestors[i]
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		access := uint32(windows.FILE_READ_ATTRIBUTES)
		if i == 0 {
			access |= windows.READ_CONTROL | windows.WRITE_DAC
		}
		open := func() (windows.Handle, error) {
			return windows.CreateFile(name, access,
				windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
				windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		}
		handle, err := open()
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
				return fmt.Errorf("create private network state directory %q: %w", path, err)
			}
			handle, err = open()
		}
		if err != nil {
			return fmt.Errorf("open private network state directory %q; use a directory owned by the current Windows user or its enabled Administrators group: %w", path, err)
		}
		defer windows.CloseHandle(handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			return fmt.Errorf("inspect private network state directory %q: %w", path, err)
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("private network state path must not contain a reparse point: %s", path)
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return fmt.Errorf("private network state path is not a directory: %s", path)
		}
		directory = handle
		directoryInfo = info
	}
	sd, err := windows.GetSecurityInfo(directory, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read private network state directory owner: %w", err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("read private network state directory owner: %w", err)
	}
	allowed, err := stateDirOwnerAllowed(owner, user.User.Sid)
	if err != nil {
		return fmt.Errorf("check private network state directory owner: %w", err)
	}
	if !allowed {
		return fmt.Errorf("private network state directory is not owned by the current Windows user or its enabled Administrators group; choose a user-owned directory: %s", stateDir)
	}

	// Match Tailscale's private directory ACL: only this user and local
	// Administrators get full access, inherited by state files and subfolders.
	private, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;BA)")
	if err != nil {
		return fmt.Errorf("create private network state permissions: %w", err)
	}
	dacl, _, err := private.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(directory, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("secure private network state directory %q: %w", stateDir, err)
	}
	if !owner.Equals(user.User.Sid) {
		// Elevated creation commonly assigns Administrators as owner. Normalize
		// it now, before tsnet starts, so a later normal UAC token can reopen it.
		// Reopen only after granting Full Control: a user-owned Modify directory
		// must not require WRITE_OWNER before its DACL has been repaired.
		name, err := windows.UTF16PtrFromString(stateDir)
		if err != nil {
			return err
		}
		ownerHandle, err := windows.CreateFile(name, windows.WRITE_OWNER|windows.FILE_READ_ATTRIBUTES,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return fmt.Errorf("open private network state directory to normalize its owner: %w", err)
		}
		defer windows.CloseHandle(ownerHandle)
		var reopened windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(ownerHandle, &reopened); err != nil {
			return fmt.Errorf("verify private network state directory before normalizing its owner: %w", err)
		}
		if reopened.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
			reopened.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
			reopened.VolumeSerialNumber != directoryInfo.VolumeSerialNumber ||
			reopened.FileIndexHigh != directoryInfo.FileIndexHigh || reopened.FileIndexLow != directoryInfo.FileIndexLow {
			return fmt.Errorf("private network state directory changed before normalizing its owner: %s", stateDir)
		}
		if err := windows.SetSecurityInfo(ownerHandle, windows.SE_FILE_OBJECT,
			windows.OWNER_SECURITY_INFORMATION, user.User.Sid, nil, nil, nil); err != nil {
			return fmt.Errorf("normalize private network state directory owner for normal Windows restarts: %w", err)
		}
	}
	return nil
}

func stateDirOwnerAllowed(owner, currentUser *windows.SID) (bool, error) {
	if owner == nil {
		return false, nil
	}
	if owner.Equals(currentUser) {
		return true, nil
	}
	// An elevated administrator's default owner is commonly Administrators.
	// IsMember excludes the deny-only Administrators SID of a normal UAC token.
	if owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		// CheckTokenMembership needs an impersonation token; zero asks Windows
		// to duplicate the calling thread's effective token for this check.
		return windows.Token(0).IsMember(owner)
	}
	return false, nil
}
