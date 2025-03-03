"use strict";

import {
    http_get, http_post, http_options, prepare, basename, dirname, pathBuilder,
    filetype, currentShare, currentBackend, appendShareToUrl,
} from "../helpers/";

import { Observable } from "rxjs";
import { cache } from "../helpers/";

class FileSystem {
    constructor() {
        this.obs = null;
        this.current_path = null;
    }

    ls(path, show_hidden = false) {
        this.current_path = path;
        this.obs && this.obs.complete();
        return Observable.create((obs) => {
            this.obs = obs;
            let keep_pulling_from_http = false;
            this._ls_from_cache(path, true).then((cache) => {
                const fetch_from_http = (_path) => {
                    return this._ls_from_http(_path, show_hidden)
                        .then(() => new Promise((done, err) => {
                            window.setTimeout(() => done(), 2000);
                        })).then(() => {
                            if (keep_pulling_from_http === false) return Promise.resolve();
                            return fetch_from_http(_path);
                        }).catch((err) => {
                            this.obs && this.obs.error(err);
                        });
                };
                fetch_from_http(path);
            }).catch((err) => this.obs.error({ message: err && err.message }));

            return () => {
                keep_pulling_from_http = false;
            };
        });
    }

    _ls_from_http(path, show_hidden) {
        const url = appendShareToUrl("/api/files/ls?path=" + prepare(path));
        return http_get(url).then((response) => {
            response = fileMiddleware(response, path, show_hidden);

            return cache.upsert(cache.FILE_PATH, [currentBackend(), currentShare(), path], (_files) => {
                const store = Object.assign({
                    backend: currentBackend(),
                    share: currentShare(),
                    status: "ok",
                    path: path,
                    results: null,
                    access_count: 0,
                    permissions: null,
                }, _files);
                store.permissions = response.permissions;
                store.results = response.results;

                if (_files && _files.results) {
                    store.access_count = _files.access_count;
                    // find out which entry we want to keep from the cache
                    const _files_virtual_to_keep = _files.results.filter((file) => {
                        return file.icon === "loading";
                    });
                    // update file results when something is going on
                    for (let i=0; i<_files_virtual_to_keep.length; i++) {
                        for (let j=0; j<store.results.length; j++) {
                            if (store.results[j].name === _files_virtual_to_keep[i].name) {
                                store.results[j] = Object.assign({}, _files_virtual_to_keep[i]);
                                _files_virtual_to_keep.splice(i, 1);
                                i -= 1;
                                break;
                            }
                        }
                    }
                    // add stuff that didn't exist in our response
                    store.results = store.results.concat(_files_virtual_to_keep);
                }
                store.last_update = new Date();
                store.last_access = new Date();
                return store;
            }).catch(() => Promise.resolve(response)).then((data) => {
                if (this.current_path === path) {
                    this.obs && this.obs.next(data);
                }
                return Promise.resolve(null);
            });
        }).catch((_err) => {
            this.obs.next(_err);
            return Promise.reject(_err);
        });
    }

    _ls_from_cache(path, _record_access = false) {
        return cache.get(cache.FILE_PATH, [currentBackend(), currentShare(), path]).then((response) => {
            if (!response || !response.results) return null;
            if (this.current_path === path) {
                this.obs && this.obs.next({
                    status: "ok",
                    results: response.results,
                    permissions: response.permissions,
                });
            }
            return response;
        }).then((e) => {
            requestAnimationFrame(() => {
                if (_record_access === true) {
                    cache.upsert(cache.FILE_PATH, [currentBackend(), currentShare(), path], (response) => {
                        if (!response || !response.results) return null;
                        if (this.current_path === path) {
                            this.obs && this.obs.next({
                                status: "ok",
                                results: response.results,
                                permissions: response.permissions,
                            });
                        }
                        response.last_access = new Date();
                        response.access_count += 1;
                        return response;
                    });
                }
            });
            return Promise.resolve(e);
        });
    }

    rm(path) {
        const url = appendShareToUrl("/api/files/rm?path=" + prepare(path));
        return this._replace(path, "loading")
            .then((res) => this.current_path === dirname(path) ?
                this._ls_from_cache(dirname(path)) : Promise.resolve(res))
            .then(() => http_post(url))
            .then((res) => {
                return cache.remove(cache.FILE_CONTENT, [currentBackend(), currentShare(), path])
                    .then(cache.remove(cache.FILE_CONTENT, [currentBackend(), currentShare(), path], false))
                    .then(cache.remove(cache.FILE_PATH, [currentBackend(), currentShare(), dirname(path)], false))
                    .then(this._remove(path, "loading"))
                    .then((res) => this.current_path === dirname(path) ?
                        this._ls_from_cache(dirname(path)) : Promise.resolve(res));
            })
            .catch((err) => {
                return this._replace(path, "error", "loading")
                    .then((res) => this.current_path === dirname(path) ?
                        this._ls_from_cache(dirname(path)) : Promise.resolve(res))
                    .then(() => Promise.reject(err));
            });
    }

    cat(path) {
        const url = appendShareToUrl("/api/files/cat?path=" + prepare(path));
        return http_get(url, "raw")
            .then((res) => {
                if (this.is_binary(res) === true) {
                    return Promise.reject({ code: "BINARY_FILE" });
                }
                return cache.upsert(cache.FILE_CONTENT, [currentBackend(), currentShare(), path], (response) => {
                    const file = response ? response : {
                        backend: currentBackend(),
                        share: currentShare(),
                        path: path,
                        last_update: null,
                        last_access: null,
                        access_count: -1,
                        result: null,
                    };
                    file.result = res;
                    file.access_count += 1;
                    file.last_access = new Date();
                    return file;
                }).then((response) => Promise.resolve(response.result));
            });
    }

    zip(paths) {
        let url = appendShareToUrl("/api/files/zip?" + paths.map((p) => "path=" + prepare(p)).join("&"));
        if (paths.length === 1 && filetype(paths[0]) === "file") {
            url = appendShareToUrl("/api/files/cat?path=" + prepare(paths[0]) + "&name=" + basename(paths[0]));
        }
        window.open(url);
        return Promise.resolve();
    }
    unzip(paths, signal) {
        const url = appendShareToUrl(
            "/api/files/unzip?" + paths.map((p) => "path=" + prepare(p)).join("&"),
        );
        return fetch(url, { signal, method: "POST" }).then((r) => {
            if (r.ok) return r.json();
            return r.json().then((err) => {
                throw new Error(err.message);
            });
        });
    }

    options(path) {
        const url = appendShareToUrl("/api/files/cat?path=" + prepare(path));
        return http_options(url);
    }

    url(path) {
        const url = appendShareToUrl("/api/files/cat?path=" + prepare(path));
        return Promise.resolve(url);
    }

    save(path, file) {
        const url = appendShareToUrl("/api/files/cat?path=" + prepare(path));
        return this._replace(path, "loading")
            .then(() => http_post(url, file, "blob"))
            .then(() => {
                return this._saveFileToCache(path, file)
                    .then(() => this._replace(path, null, "loading"))
                    .then(() => this._refresh(path));
            })
            .catch((err) => {
                return this._replace(path, "error", "loading")
                    .then(() => this._refresh(path))
                    .then(() => Promise.reject(err));
            });
    }

    mkdir(path, step) {
        const url = appendShareToUrl("/api/files/mkdir?path=" + prepare(path));
        const origin_path = pathBuilder(this.current_path, basename(path), "directoy");
        const destination_path = path;

        const action_prepare = (part_of_a_batch_operation = false) => {
            if (part_of_a_batch_operation === true) {
                return this._add(destination_path, "loading")
                    .then(() => this._refresh(destination_path));
            }

            return this._add(destination_path, "loading")
                .then(() => origin_path !== destination_path ?
                    this._add(origin_path, "loading") : Promise.resolve())
                .then(() => this._refresh(origin_path, destination_path));
        };

        const action_execute = (part_of_a_batch_operation = false) => {
            if (part_of_a_batch_operation === true) {
                return http_post(url)
                    .then(() => {
                        return this._replace(destination_path, null, "loading")
                            .then(() => this._refresh(destination_path));
                    })
                    .catch((err) => {
                        this._replace(destination_path, "error", "loading")
                            .then(() => this._refresh(origin_path, destination_path));
                        return Promise.reject(err);
                    });
            }

            return http_post(url)
                .then(() => {
                    return this._replace(destination_path, null, "loading")
                        .then(() => origin_path !== destination_path ?
                            this._remove(origin_path, "loading") : Promise.resolve())
                        .then(() => cache.add(cache.FILE_PATH, [currentBackend(), currentShare(), destination_path], {
                            path: destination_path,
                            backend: currentBackend(),
                            share: currentShare(),
                            results: [],
                            access_count: 0,
                            last_access: null,
                            last_update: new Date(),
                        }))
                        .then(() => this._refresh(origin_path, destination_path));
                })
                .catch((err) => {
                    this._replace(origin_path, "error", "loading")
                        .then(() => origin_path !== destination_path ?
                            this._remove(destination_path, "loading") : Promise.resolve())
                        .then(() => this._refresh(origin_path, destination_path));
                    return Promise.reject(err);
                });
        };

        switch(step) {
        case "prepare_only": return action_prepare(true);
        case "execute_only": return action_execute(true);
        default: return action_prepare().then(action_execute);
        }
    }

    touch(path, file, step, params) {
        const origin_path = pathBuilder(this.current_path, basename(path), "file");
        const destination_path = path;

        const action_prepare = (part_of_a_batch_operation = false) => {
            if (part_of_a_batch_operation === true) {
                return this._add(destination_path, "loading")
                    .then(() => this._refresh(destination_path));
            } else {
                return this._add(destination_path, "loading")
                    .then(() => origin_path !== destination_path ? this._add(origin_path, "loading") : Promise.resolve())
                    .then(() => this._refresh(origin_path, destination_path));
            }
        };
        const action_execute = (part_of_a_batch_operation = false) => {
            if (part_of_a_batch_operation === true) {
                return query()
                    .then(() => {
                        return this._replace(destination_path, null, "loading")
                            .then(() => this._refresh(destination_path));
                    })
                    .catch((err) => {
                        this._replace(destination_path, null, "error")
                            .then(() => this._replace(destination_path, null, "loading"))
                            .then(() => this._refresh(destination_path));
                        return Promise.reject(err);
                    });
            }
            return query()
                .then(() => {
                    return this._saveFileToCache(path, file)
                        .then(() => this._replace(destination_path, null, "loading"))
                        .then(() => origin_path !== destination_path ?
                            this._remove(origin_path, "loading") : Promise.resolve())
                        .then(() => this._refresh(origin_path, destination_path));
                })
                .catch((err) => {
                    this._replace(origin_path, "error", "loading")
                        .then(() => origin_path !== destination_path ?
                            this._remove(destination_path, "loading") : Promise.resolve())
                        .then(() => this._refresh(origin_path, destination_path));
                    return Promise.reject(err);
                });

            function query() {
                if (file) {
                    const url = appendShareToUrl("/api/files/cat?path=" + prepare(path));
                    return http_post(url, file, "blob", params);
                } else {
                    const url = appendShareToUrl("/api/files/touch?path=" + prepare(path));
                    return http_post(url);
                }
            }
        };

        switch(step) {
        case "prepare_only": return action_prepare(true);
        case "execute_only": return action_execute(true);
        default: return action_prepare().then(action_execute);
        }
    }

    mv(from, to) {
        const url = appendShareToUrl("/api/files/mv?from=" + prepare(from) + "&to=" + prepare(to));
        const origin_path = from;
        const destination_path = to;

        return this._replace(origin_path, "loading")
            .then(this._add(destination_path, "loading"))
            .then(() => this._refresh(origin_path, destination_path))
            .then(() => http_post(url))
            .then((res) => {
                return this._remove(origin_path, "loading")
                    .then(() => this._replace(destination_path, null, "loading"))
                    .then(() => this._refresh(origin_path, destination_path))
                    .then(() => {
                        cache.update(cache.FILE_PATH, [currentBackend(), currentShare(), origin_path], (data) => {
                            data.path = data.path.replace(origin_path, destination_path);
                            return data;
                        }, false);
                        cache.update(cache.FILE_CONTENT, [currentBackend(), currentShare(), origin_path], (data) => {
                            data.path = data.path.replace(origin_path, destination_path);
                            return data;
                        }, false);
                        return Promise.resolve();
                    });
            })
            .catch((err) => {
                this._replace(origin_path, "error", "loading")
                    .then(() => this._remove(destination_path, "loading"))
                    .then(() => this._refresh(origin_path, destination_path));
                return Promise.reject(err);
            });
    }

    search(keyword, path = "/", show_hidden) {
        const url = appendShareToUrl(
            "/api/files/search?path=" + prepare(path) +
                "&q="+encodeURIComponent(keyword),
        );
        return http_get(url).then((response) => {
            response = fileMiddleware(response, path, show_hidden);
            return response.results;
        });
    }

    frequents() {
        const data = [];
        return cache.fetchAll((value) => {
            if (value.access_count >= 1 && value.path !== "/") {
                data.push(value);
            }
        }, cache.FILE_PATH, [currentBackend(), currentShare(), "/"]).then(() => {
            return Promise.resolve(
                data
                    .sort((a, b) => a.access_count > b.access_count? -1 : 1)
                    .map((a) => a.path)
                    .slice(0, 6),
            );
        });
    }

    _saveFileToCache(path, file) {
        if (!file) return update_cache("");
        return new Promise((done, err) => {
            const reader = new FileReader();
            reader.readAsText(file);
            reader.onload = () => this.is_binary(reader.result) === false ?
                update_cache(reader.result).then(done) : done();
            reader.onerror = (_err) => err(_err);
        });

        function update_cache(result) {
            return cache.upsert(cache.FILE_CONTENT, [currentBackend(), currentShare(), path], (response) => {
                if (!response) {
                    response = {
                        backend: currentBackend(),
                        share: currentShare(),
                        path: path,
                        last_access: null,
                        last_update: null,
                        result: null,
                        access_count: 0,
                    };
                }
                response.last_update = new Date();
                response.result = result;
                return response;
            });
        }
    }

    _refresh(origin_path, destination_path) {
        if (this.current_path === dirname(origin_path) ||
           this.current_path === dirname(destination_path)) {
            return this._ls_from_cache(this.current_path);
        }
        return Promise.resolve();
    }

    _replace(path, icon, icon_previous) {
        return cache.update(cache.FILE_PATH, [currentBackend(), currentShare(), dirname(path)], function(res) {
            res.results = res.results.map((file) => {
                if (file.name === basename(path) && file.icon == icon_previous) {
                    if (!icon) {
                        delete file.icon;
                    }
                    if (icon) {
                        file.icon = icon;
                    }
                }
                return file;
            });
            return res;
        });
    }
    _add(path, icon) {
        return cache.upsert(cache.FILE_PATH, [currentBackend(), currentShare(), dirname(path)], (res) => {
            const file = mutateFile({
                path: path,
                name: basename(path),
                type: filetype(path),
            }, path);
            if (icon) file.icon = icon;

            if (!res || !res.results) {
                res = {
                    path: dirname(path),
                    backend: currentBackend(),
                    share: currentShare(),
                    results: [],
                    access_count: 0,
                    last_access: null,
                    last_update: new Date(),
                };
                if (file.type === "directory") {
                    return res;
                }
            }
            res.results.push(file);
            return res;
        });
    }
    _remove(path, previous_icon) {
        return cache.update(cache.FILE_PATH, [currentBackend(), currentShare(), dirname(path)], function(res) {
            if (!res) return null;
            res.results = res.results.filter((file) => {
                return file.name === basename(path) && file.icon == previous_icon ? false : true;
            });
            return res;
        });
    }


    is_binary(str) {
        // Reference: https://en.wikipedia.org/wiki/Specials_(Unicode_block)#Replacement_character
        return /\ufffd/.test(str);
    }
}


const createLink = (type, path) => {
    return type === "file" ? "/view" + path : "/files" + path;
};

const fileMiddleware = (response, path, show_hidden) => {
    for (let i=0; i<response.results.length; i++) {
        const f = mutateFile(response.results[i], path);
        if (show_hidden === false && f.path.indexOf("/.") !== -1) {
            response.results.splice(i, 1);
            i -= 1;
        }
    }
    return response;
};

const mutateFile = (file, path) => {
    if (file.path === undefined) {
        file.path = pathBuilder(path, file.name, file.type);
    }
    file.link = createLink(file.type, file.path);
    return file;
};

export const Files = new FileSystem();
