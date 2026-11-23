
// Directory metadata arrives in batches on APFS. Other filesystems can fall
// back to directory entries and fstatat without crossing a mount or a symlink.
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/vnode.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <optional>
#include <unordered_set>
#include <string>
#include <vector>

namespace {
constexpr char mountsRoot[] = "/System/Volumes";
constexpr char dataRoot[] = "/System/Volumes/Data";
constexpr int scanFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC;

void jsonString(const char* s) {
    std::putchar('"');
    for (const auto* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
        if (*p == '"' || *p == '\\') {
            std::putchar('\\');
            std::putchar(*p);
        } else if (*p < 32) {
            std::printf("\\u%04x", *p);
        } else {
            std::putchar(*p);
        }
    }
    std::putchar('"');
}

std::string volumeName(const struct statfs& mount) {
    const std::string root = mount.f_mntonname;
    if (!(mount.f_flags & MNT_LOCAL)) return root.substr(root.find_last_of('/') + 1);
    struct attrlist attrs {};
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.volattr = ATTR_VOL_INFO | ATTR_VOL_NAME;
    struct {
        uint32_t length;
        attrreference_t name;
        char data[MAXPATHLEN];
    } buffer {};
    if (getattrlist(root.c_str(), &attrs, &buffer, sizeof(buffer), 0) == 0) {
        const auto offset = static_cast<int64_t>(offsetof(decltype(buffer), name)) + buffer.name.attr_dataoffset;
        if (offset >= 0 && offset < sizeof(buffer) &&
            buffer.name.attr_length > 1 && buffer.name.attr_length <= sizeof(buffer) - offset) {
            const auto* label = reinterpret_cast<const char*>(&buffer) + offset;
            if (label[buffer.name.attr_length - 1] == '\0') return label;
        }
    }
    return root == "/" ? "macOS" : root.substr(root.find_last_of('/') + 1);
}

int volumes() {
    struct statfs* list = nullptr;
    const int count = getmntinfo(&list, MNT_NOWAIT);
    if (count == 0) return 1;
    std::putchar('[');
    for (int i = 0; i < count; ++i) {
        const auto& m = list[i];
        if (i) std::putchar(',');
        std::fputs("{\"root\":", stdout);
        jsonString(m.f_mntonname);
        std::fputs(",\"fs\":", stdout);
        jsonString(m.f_fstypename);
        std::fputs(",\"label\":", stdout);
        jsonString(volumeName(m).c_str());
        std::printf(",\"local\":%s}", m.f_flags & MNT_LOCAL ? "true" : "false");
    }
    std::puts("]");
    return std::ferror(stdout) ? 1 : 0;
}

struct Entry {
    fsobj_type_t type;
    int64_t size, allocated, created, modified, accessed;
    uint64_t inode;
    uint32_t links;
};

// getattrlist records are packed on 4-byte boundaries. No unaligned casts.
struct __attribute__((packed)) BulkRecord {
    uint32_t length;
    attribute_set_t valid;
    uint32_t error;
    attrreference_t name;
    fsobj_type_t type;
    timespec created, modified, accessed;
    uint64_t inode;
    uint32_t links;
    off_t size, allocated;
};

constexpr attrgroup_t common = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_ERROR |
    ATTR_CMN_OBJTYPE | ATTR_CMN_CRTIME | ATTR_CMN_MODTIME | ATTR_CMN_ACCTIME | ATTR_CMN_FILEID;
constexpr attrgroup_t file = ATTR_FILE_LINKCOUNT | ATTR_FILE_TOTALSIZE | ATTR_FILE_ALLOCSIZE;

struct Folder {
    uint32_t id;
    unsigned depth;
    std::string path;
};

enum class Bulk { done, unsupported, failed };

class Walk {
    std::vector<Folder> pending;
    std::optional<Folder> residualData;
    std::unordered_set<ino_t> dataDirs;
    bool scanningResidual = false;
    uint32_t lastID = 0;
    uint64_t bulkEntries = 0;
    dev_t device = 0;
    dev_t dataDevice = 0;
    bool includesData = false;
    const bool startup;
    const std::string volumeTrash;
    const std::string uid = std::to_string(getuid());
    alignas(8) char buffer[64 * 1024];

    void error(uint32_t id) { std::printf("[%u]\n", id); }

    void emit(const Folder& parent, const char* name, const Entry& e, dev_t dev) {
        if (std::strcmp(name, ".") == 0 || std::strcmp(name, "..") == 0) return;
        if (e.type != VDIR && e.type != VREG && e.type != VLNK) return;
        if (e.type == VDIR) {
            std::string full = parent.path == "/" ? parent.path + name : parent.path + "/" + name;
            if (startup && full == "/Volumes") return;
            if (scanningResidual) {
                struct stat st {};
                if (lstat(full.c_str(), &st) == 0 && st.st_dev == dataDevice && dataDirs.count(st.st_ino)) return;
            }
            Folder child {lastID + 1, parent.depth + 1, std::move(full)};
            if (startup && child.path == dataRoot) residualData = std::move(child);
            else pending.push_back(std::move(child));
        }
        ++lastID;
        // [parent ID, parent depth, kind, name, size, alloc, mtime, atime, birthtime, hard-link identity]
        const int kind = e.type == VDIR ? 1 : e.type == VLNK ? 2 : 0;
        std::printf("[%u,%u,%d,", parent.id, parent.depth, kind);
        jsonString(name);
        std::printf(",%lld,%lld,%lld,%lld,%lld", std::max(0LL, static_cast<long long>(e.size)),
            std::max(0LL, static_cast<long long>(e.allocated)), static_cast<long long>(e.modified),
            static_cast<long long>(e.accessed), static_cast<long long>(e.created));
        if (kind == 0 && e.links > 1) {
            std::printf(",\"%u:%llu\"", static_cast<unsigned>(dev), static_cast<unsigned long long>(e.inode));
        }
        std::puts("]");
    }

    void entryStat(int fd, const Folder& folder, const char* name) {
        struct stat st {};
        if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
            if (errno != ENOENT) error(folder.id);
            return;
        }
        const auto type = S_ISDIR(st.st_mode) ? VDIR : S_ISLNK(st.st_mode) ? VLNK : S_ISREG(st.st_mode) ? VREG : VNON;
        emit(folder, name, {type, st.st_size, st.st_blocks * 512, st.st_birthtimespec.tv_sec,
            st.st_mtimespec.tv_sec, st.st_atimespec.tv_sec, st.st_ino, static_cast<uint32_t>(st.st_nlink)}, st.st_dev);
    }

    Bulk bulk(int fd, const Folder& folder, dev_t dev) {
        struct attrlist attrs {};
        attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
        attrs.commonattr = common;
        attrs.fileattr = file;
        bool started = false;
        while (true) {
            const int count = getattrlistbulk(fd, &attrs, buffer, sizeof(buffer), FSOPT_PACK_INVAL_ATTRS);
            if (count < 0) {
                if (errno == EINTR) continue;
                return started ? Bulk::failed : Bulk::unsupported;
            }
            if (count == 0) return Bulk::done;
            started = true;
            size_t offset = 0;
            for (int i = 0; i < count; ++i) {
                uint32_t length = 0;
                if (offset + sizeof(length) > sizeof(buffer)) return Bulk::failed;
                std::memcpy(&length, buffer + offset, sizeof(length));
                if (length < offsetof(BulkRecord, type) || length > sizeof(buffer) - offset) return Bulk::failed;
                BulkRecord row {};
                const auto* raw = buffer + offset;
                std::memcpy(&row, raw, std::min(sizeof(row), static_cast<size_t>(length)));
                offset += length;
                const auto nameOffset = static_cast<int64_t>(offsetof(BulkRecord, name)) + row.name.attr_dataoffset;
                if (!(row.valid.commonattr & ATTR_CMN_NAME) || nameOffset < 0 || nameOffset >= length ||
                    row.name.attr_length < 2 || row.name.attr_length > length - nameOffset ||
                    raw[nameOffset + row.name.attr_length - 1] != '\0') {
                    error(folder.id);
                    continue;
                }
                const char* name = raw + nameOffset;
                const auto required = common & ~ATTR_CMN_ERROR;
                if (row.error || length < offsetof(BulkRecord, links) || (row.valid.commonattr & required) != required ||
                    (row.type == VREG && (length < sizeof(row) || (row.valid.fileattr & file) != file))) {
                    entryStat(fd, folder, name);
                    continue;
                }
                ++bulkEntries;
                const bool regular = row.type == VREG;
                emit(folder, name, {row.type, regular ? row.size : 0, regular ? row.allocated : 0,
                    row.created.tv_sec, row.modified.tv_sec, row.accessed.tv_sec, row.inode, regular ? row.links : 0}, dev);
            }
        }
    }

    void directory(const Folder& folder) {
        if (startup && folder.path == mountsRoot) {
            // Walk the merged view first, then include Data entries with no visible alias.
            if (includesData) emit(folder, "Data", {VDIR, 0, 0, 0, 0, 0, 0, 0}, dataDevice);
            return;
        }
        if (folder.path == volumeTrash) {
            // .Trashes can allow traversal of our UID directory without allowing listing.
            const int trash = open(folder.path.c_str(), O_SEARCH | O_NOFOLLOW_ANY | O_CLOEXEC);
            if (trash < 0) return error(folder.id);
            struct stat st {};
            if (fstatat(trash, uid.c_str(), &st, AT_SYMLINK_NOFOLLOW) == 0) {
                if (S_ISDIR(st.st_mode) && st.st_uid == getuid() && st.st_dev == device) {
                    emit(folder, uid.c_str(), {VDIR, 0, 0, 0, 0, 0, 0, 0}, st.st_dev);
                }
            } else if (errno != ENOENT) error(folder.id);
            close(trash);
            return;
        }
        int fd = open(folder.path.c_str(), scanFlags);
        if (fd < 0) return error(folder.id);
        struct stat st {};
        if (fstat(fd, &st) != 0) {
            close(fd);
            return error(folder.id);
        }
        if (st.st_dev != device && !(includesData && st.st_dev == dataDevice)) {
            close(fd);
            return;
        }
        if (includesData && st.st_dev == dataDevice && !dataDirs.insert(st.st_ino).second) {
            close(fd);
            return;
        }
        const auto result = bulk(fd, folder, st.st_dev);
        close(fd);
        if (result == Bulk::done) return;
        if (result == Bulk::failed) return error(folder.id);

        // Mixing getattrlistbulk and readdir on one descriptor is undefined.
        fd = open(folder.path.c_str(), scanFlags);
        if (fd < 0) return error(folder.id);
        struct stat reopened {};
        if (fstat(fd, &reopened) != 0 || reopened.st_dev != st.st_dev || reopened.st_ino != st.st_ino) {
            close(fd);
            return error(folder.id);
        }
        DIR* dir = fdopendir(fd);
        if (!dir) {
            close(fd);
            return error(folder.id);
        }
        while (true) {
            errno = 0;
            const dirent* entry = readdir(dir);
            if (!entry) {
                if (errno) error(folder.id);
                break;
            }
            if (std::strcmp(entry->d_name, ".") && std::strcmp(entry->d_name, "..")) entryStat(fd, folder, entry->d_name);
        }
        closedir(dir);
    }

public:
    Walk(const std::string& root, const std::string& trashParent)
        : startup(root == "/"), volumeTrash(trashParent) { pending.push_back({0, 0, root}); }

    int run() {
        struct stat st {};
        if (lstat(pending.front().path.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) return 1;
        device = st.st_dev;
        if (startup && stat(dataRoot, &st) == 0) {
            includesData = true;
            dataDevice = st.st_dev;
        }
        while (!pending.empty() || residualData) {
            if (pending.empty()) {
                pending.push_back(std::move(*residualData));
                residualData.reset();
                scanningResidual = true;
            }
            Folder folder = std::move(pending.back());
            pending.pop_back();
            directory(folder);
        }
        std::printf("[\"done\",%llu]\n", static_cast<unsigned long long>(bulkEntries));
        return std::fflush(stdout) == 0 && !std::ferror(stdout) ? 0 : 1;
    }
};

bool sameEntry(const struct stat& a, const struct stat& b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

bool removeAt(int parent, const char* name, const struct stat& expected, bool contents) {
    if (S_ISDIR(expected.st_mode)) {
        const int fd = openat(parent, name, scanFlags);
        if (fd < 0) return false;
        struct stat pinned {};
        if (fstat(fd, &pinned) != 0 || !sameEntry(pinned, expected)) {
            close(fd);
            return false;
        }
        DIR* dir = fdopendir(fd);
        if (!dir) {
            close(fd);
            return false;
        }
        // Snapshot names before mutating the directory's entries.
        std::vector<std::string> names;
        while (true) {
            errno = 0;
            const auto* child = readdir(dir);
            if (!child) break;
            if (std::strcmp(child->d_name, ".") && std::strcmp(child->d_name, "..")) names.emplace_back(child->d_name);
        }
        bool ok = errno == 0;
        for (const auto& child : names) {
            struct stat st {};
            if (fstatat(fd, child.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0) {
                if (errno != ENOENT) ok = false;
                continue;
            }
            if (st.st_dev != pinned.st_dev || !removeAt(fd, child.c_str(), st, false)) ok = false;
        }
        closedir(dir);
        if (contents || !ok) return ok;
    } else if (contents || (!S_ISREG(expected.st_mode) && !S_ISLNK(expected.st_mode))) return false;

    struct stat current {};
    return fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        sameEntry(current, expected) && unlinkat(parent, name, S_ISDIR(expected.st_mode) ? AT_REMOVEDIR : 0) == 0;
}

int cleanup(const char* mode, const char* parentPath, const char* name, const char* device, const char* inode) {
    const bool contents = std::strcmp(mode, "contents") == 0;
    if ((!contents && std::strcmp(mode, "permanent")) || !*name || std::strchr(name, '/') ||
        !std::strcmp(name, ".") || !std::strcmp(name, "..")) return 2;

    const int parent = open(parentPath, O_SEARCH | O_NOFOLLOW_ANY | O_CLOEXEC);
    if (parent < 0) return 1;
    struct stat st {}, parentStat {};
    const bool ok = fstat(parent, &parentStat) == 0 && fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0 &&
        st.st_dev == parentStat.st_dev && st.st_dev == static_cast<dev_t>(std::strtoll(device, nullptr, 10)) &&
        st.st_ino == std::strtoull(inode, nullptr, 10) && removeAt(parent, name, st, contents);
    close(parent);
    return ok ? 0 : 1;
}
}

int main(int argc, char** argv) {
    if (argc == 7 && std::strcmp(argv[1], "--remove") == 0) return cleanup(argv[2], argv[3], argv[4], argv[5], argv[6]);
    if (argc == 2 && std::strcmp(argv[1], "--volumes") == 0) return volumes();
    if (argc != 3) return 2;
    std::setvbuf(stdout, nullptr, _IOFBF, 64 * 1024);
    return Walk(argv[1], argv[2]).run();
}
