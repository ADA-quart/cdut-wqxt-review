package io.github.adaquart.qingqu;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * App 内更新：用系统 DownloadManager 下载 APK，完成后自动拉起系统安装器。
 * 不经过浏览器（此前用 Chrome Custom Tab 会把任务切到浏览器，最近任务变成"浏览器"）。
 */
@CapacitorPlugin(name = "UpdateInstaller")
public class UpdateInstallerPlugin extends Plugin {

    private long downloadId = -1;
    private String fileName = "qingqu-update.apk";
    private BroadcastReceiver receiver;

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("fileName", "qingqu-update.apk");
        if (url == null || url.isEmpty()) {
            call.reject("缺少 url");
            return;
        }
        fileName = String.valueOf(name).replaceAll("[^A-Za-z0-9._-]", "_");
        try {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                call.reject("系统下载服务不可用");
                return;
            }
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir != null) dir.mkdirs();

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType("application/vnd.android.package-archive");
            req.setTitle("清渠更新");
            req.setDescription(fileName);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName);
            downloadId = dm.enqueue(req);
            registerCompleteReceiver();

            JSObject ret = new JSObject();
            ret.put("id", downloadId);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("下载启动失败：" + e.getMessage());
        }
    }

    private void registerCompleteReceiver() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                unregisterCompleteReceiver();
                if (isSuccessful(downloadId)) installApk();
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    private void unregisterCompleteReceiver() {
        try {
            if (receiver != null) getContext().unregisterReceiver(receiver);
        } catch (Exception ignored) { /* 已注销 */ }
        receiver = null;
    }

    private boolean isSuccessful(long id) {
        try {
            DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return false;
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                if (c == null || !c.moveToFirst()) return false;
                return c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL;
            }
        } catch (Exception e) {
            return false;
        }
    }

    /** 用 FileProvider 暴露 app 私有下载目录里的 APK，拉起系统安装器 */
    private void installApk() {
        try {
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File apk = new File(dir, fileName);
            if (!apk.exists()) return;
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            /* 安装器拉不起来时，用户仍可点下载完成的通知手动安装 */
        }
    }
}
