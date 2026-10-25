export declare const composeSpecSchema: {
    $schema: string;
    $id: string;
    type: string;
    title: string;
    description: string;
    properties: {
        version: {
            type: string;
            deprecated: boolean;
            description: string;
        };
        name: {
            type: string;
            description: string;
        };
        include: {
            type: string;
            items: {
                $ref: string;
            };
            description: string;
        };
        services: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        models: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        networks: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        volumes: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        secrets: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        configs: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
        jobs: {
            type: string;
            patternProperties: {
                "^[a-zA-Z0-9._-]+$": {
                    $ref: string;
                };
            };
            additionalProperties: boolean;
            description: string;
        };
    };
    patternProperties: {
        "^x-": {};
    };
    additionalProperties: boolean;
    $defs: {
        container_spec: {
            type: string;
            description: string;
            properties: {
                annotations: {
                    $ref: string;
                };
                blkio_config: {
                    type: string;
                    description: string;
                    properties: {
                        device_read_bps: {
                            type: string;
                            description: string;
                            items: {
                                $ref: string;
                            };
                        };
                        device_read_iops: {
                            type: string;
                            description: string;
                            items: {
                                $ref: string;
                            };
                        };
                        device_write_bps: {
                            type: string;
                            description: string;
                            items: {
                                $ref: string;
                            };
                        };
                        device_write_iops: {
                            type: string;
                            description: string;
                            items: {
                                $ref: string;
                            };
                        };
                        weight: {
                            type: string[];
                            description: string;
                        };
                        weight_device: {
                            type: string;
                            description: string;
                            items: {
                                $ref: string;
                            };
                        };
                    };
                    additionalProperties: boolean;
                };
                cap_add: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                cap_drop: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                cgroup: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                cgroup_parent: {
                    type: string;
                    description: string;
                };
                command: {
                    $ref: string;
                    description: string;
                };
                configs: {
                    $ref: string;
                    description: string;
                };
                cpu_count: {
                    oneOf: ({
                        type: string;
                        minimum?: undefined;
                    } | {
                        type: string;
                        minimum: number;
                    })[];
                    description: string;
                };
                cpu_percent: {
                    oneOf: ({
                        type: string;
                        minimum?: undefined;
                        maximum?: undefined;
                    } | {
                        type: string;
                        minimum: number;
                        maximum: number;
                    })[];
                    description: string;
                };
                cpu_shares: {
                    type: string[];
                    description: string;
                };
                cpu_quota: {
                    type: string[];
                    description: string;
                };
                cpu_period: {
                    type: string[];
                    description: string;
                };
                cpu_rt_period: {
                    type: string[];
                    description: string;
                };
                cpu_rt_runtime: {
                    type: string[];
                    description: string;
                };
                cpus: {
                    type: string[];
                    description: string;
                };
                cpuset: {
                    type: string;
                    description: string;
                };
                credential_spec: {
                    type: string;
                    description: string;
                    properties: {
                        config: {
                            type: string;
                            description: string;
                        };
                        file: {
                            type: string;
                            description: string;
                        };
                        registry: {
                            type: string;
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                device_cgroup_rules: {
                    $ref: string;
                    description: string;
                };
                devices: {
                    type: string;
                    description: string;
                    items: {
                        oneOf: ({
                            type: string;
                            required?: undefined;
                            properties?: undefined;
                            additionalProperties?: undefined;
                            patternProperties?: undefined;
                        } | {
                            type: string;
                            required: string[];
                            properties: {
                                source: {
                                    type: string;
                                    description: string;
                                };
                                target: {
                                    type: string;
                                    description: string;
                                };
                                permissions: {
                                    type: string;
                                    description: string;
                                };
                            };
                            additionalProperties: boolean;
                            patternProperties: {
                                "^x-": {};
                            };
                        })[];
                    };
                };
                dns: {
                    $ref: string;
                    description: string;
                };
                dns_opt: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                dns_search: {
                    $ref: string;
                    description: string;
                };
                domainname: {
                    type: string;
                    description: string;
                };
                entrypoint: {
                    $ref: string;
                    description: string;
                };
                env_file: {
                    $ref: string;
                    description: string;
                };
                label_file: {
                    $ref: string;
                    description: string;
                };
                environment: {
                    $ref: string;
                    description: string;
                };
                extra_hosts: {
                    $ref: string;
                    description: string;
                };
                gpus: {
                    $ref: string;
                    description: string;
                };
                group_add: {
                    type: string;
                    items: {
                        type: string[];
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                hostname: {
                    type: string;
                    description: string;
                };
                image: {
                    type: string;
                    description: string;
                };
                init: {
                    type: string[];
                    description: string;
                };
                ipc: {
                    type: string;
                    description: string;
                };
                isolation: {
                    type: string;
                    description: string;
                };
                labels: {
                    $ref: string;
                    description: string;
                };
                logging: {
                    type: string;
                    description: string;
                    properties: {
                        driver: {
                            type: string;
                            description: string;
                        };
                        options: {
                            type: string;
                            description: string;
                            patternProperties: {
                                "^.+$": {
                                    type: string[];
                                };
                            };
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                mac_address: {
                    type: string;
                    description: string;
                };
                mem_limit: {
                    type: string[];
                    description: string;
                };
                mem_reservation: {
                    type: string[];
                    description: string;
                };
                mem_swappiness: {
                    type: string[];
                    description: string;
                };
                memswap_limit: {
                    type: string[];
                    description: string;
                };
                network_mode: {
                    type: string;
                    description: string;
                };
                models: {
                    oneOf: ({
                        $ref: string;
                        type?: undefined;
                        patternProperties?: undefined;
                    } | {
                        type: string;
                        patternProperties: {
                            "^[a-zA-Z0-9._-]+$": {
                                oneOf: ({
                                    type: string;
                                    properties: {
                                        endpoint_var: {
                                            type: string;
                                            description: string;
                                        };
                                        model_var: {
                                            type: string;
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                } | {
                                    type: string;
                                    properties?: undefined;
                                    additionalProperties?: undefined;
                                    patternProperties?: undefined;
                                })[];
                            };
                        };
                        $ref?: undefined;
                    })[];
                    description: string;
                };
                networks: {
                    oneOf: ({
                        $ref: string;
                        type?: undefined;
                        patternProperties?: undefined;
                        additionalProperties?: undefined;
                    } | {
                        type: string;
                        patternProperties: {
                            "^[a-zA-Z0-9._-]+$": {
                                oneOf: ({
                                    type: string;
                                    properties: {
                                        aliases: {
                                            $ref: string;
                                            description: string;
                                        };
                                        interface_name: {
                                            type: string;
                                            description: string;
                                        };
                                        ipv4_address: {
                                            type: string;
                                            description: string;
                                        };
                                        ipv6_address: {
                                            type: string;
                                            description: string;
                                        };
                                        link_local_ips: {
                                            $ref: string;
                                            description: string;
                                        };
                                        mac_address: {
                                            type: string;
                                            description: string;
                                        };
                                        driver_opts: {
                                            type: string;
                                            description: string;
                                            patternProperties: {
                                                "^.+$": {
                                                    type: string[];
                                                };
                                            };
                                        };
                                        priority: {
                                            type: string;
                                            description: string;
                                        };
                                        gw_priority: {
                                            type: string;
                                            description: string;
                                        };
                                        use_service_name_alias: {
                                            type: string[];
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                } | {
                                    type: string;
                                    properties?: undefined;
                                    additionalProperties?: undefined;
                                    patternProperties?: undefined;
                                })[];
                            };
                        };
                        additionalProperties: boolean;
                        $ref?: undefined;
                    })[];
                    description: string;
                };
                oom_kill_disable: {
                    type: string[];
                    description: string;
                };
                oom_score_adj: {
                    oneOf: ({
                        type: string;
                        minimum?: undefined;
                        maximum?: undefined;
                    } | {
                        type: string;
                        minimum: number;
                        maximum: number;
                    })[];
                    description: string;
                };
                pid: {
                    type: string[];
                    description: string;
                };
                pids_limit: {
                    type: string[];
                    description: string;
                };
                platform: {
                    type: string;
                    description: string;
                };
                privileged: {
                    type: string[];
                    description: string;
                };
                pull_policy: {
                    type: string;
                    pattern: string;
                    description: string;
                };
                pull_refresh_after: {
                    type: string;
                    description: string;
                };
                read_only: {
                    type: string[];
                    description: string;
                };
                runtime: {
                    type: string;
                    description: string;
                };
                security_opt: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                shm_size: {
                    type: string[];
                    description: string;
                };
                secrets: {
                    $ref: string;
                    description: string;
                };
                sysctls: {
                    $ref: string;
                    description: string;
                };
                stop_grace_period: {
                    type: string;
                    description: string;
                };
                stop_signal: {
                    type: string;
                    description: string;
                };
                storage_opt: {
                    type: string;
                    description: string;
                };
                tmpfs: {
                    $ref: string;
                    description: string;
                };
                ulimits: {
                    $ref: string;
                    description: string;
                };
                umask: {
                    type: string[];
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                use_api_socket: {
                    type: string;
                    description: string;
                };
                user: {
                    type: string;
                    description: string;
                };
                uts: {
                    type: string;
                    description: string;
                };
                userns_mode: {
                    type: string;
                    description: string;
                };
                volumes: {
                    type: string;
                    description: string;
                    items: {
                        oneOf: ({
                            type: string;
                            required?: undefined;
                            properties?: undefined;
                            additionalProperties?: undefined;
                            patternProperties?: undefined;
                        } | {
                            type: string;
                            required: string[];
                            properties: {
                                type: {
                                    type: string;
                                    enum: string[];
                                    description: string;
                                };
                                source: {
                                    type: string;
                                    description: string;
                                };
                                target: {
                                    type: string;
                                    description: string;
                                };
                                read_only: {
                                    type: string[];
                                    description: string;
                                };
                                consistency: {
                                    type: string;
                                    description: string;
                                };
                                bind: {
                                    type: string;
                                    description: string;
                                    properties: {
                                        propagation: {
                                            type: string;
                                            description: string;
                                        };
                                        create_host_path: {
                                            type: string[];
                                            description: string;
                                        };
                                        recursive: {
                                            type: string;
                                            enum: string[];
                                            description: string;
                                        };
                                        selinux: {
                                            type: string;
                                            enum: string[];
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                };
                                volume: {
                                    type: string;
                                    description: string;
                                    properties: {
                                        labels: {
                                            $ref: string;
                                            description: string;
                                        };
                                        nocopy: {
                                            type: string[];
                                            description: string;
                                        };
                                        subpath: {
                                            type: string;
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                };
                                tmpfs: {
                                    type: string;
                                    description: string;
                                    properties: {
                                        size: {
                                            oneOf: ({
                                                type: string;
                                                minimum: number;
                                            } | {
                                                type: string;
                                                minimum?: undefined;
                                            })[];
                                            description: string;
                                        };
                                        mode: {
                                            type: string[];
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                };
                                image: {
                                    type: string;
                                    description: string;
                                    properties: {
                                        subpath: {
                                            type: string;
                                            description: string;
                                        };
                                    };
                                    additionalProperties: boolean;
                                    patternProperties: {
                                        "^x-": {};
                                    };
                                };
                            };
                            additionalProperties: boolean;
                            patternProperties: {
                                "^x-": {};
                            };
                        })[];
                    };
                    uniqueItems: boolean;
                };
                volumes_from: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                working_dir: {
                    type: string;
                    description: string;
                };
            };
            patternProperties: {
                "^x-": {};
            };
        };
        service: {
            description: string;
            allOf: {
                $ref: string;
            }[];
            properties: {
                deploy: {
                    $ref: string;
                };
                develop: {
                    $ref: string;
                };
                profiles: {
                    $ref: string;
                    description: string;
                };
                restart: {
                    type: string;
                    description: string;
                };
                scale: {
                    type: string[];
                    description: string;
                };
                attach: {
                    type: string[];
                };
                container_name: {
                    type: string;
                    description: string;
                    pattern: string;
                };
                provider: {
                    type: string;
                    description: string;
                    required: string[];
                    properties: {
                        type: {
                            type: string;
                            description: string;
                        };
                        options: {
                            type: string;
                            description: string;
                            patternProperties: {
                                "^.+$": {
                                    oneOf: ({
                                        type: string[];
                                        items?: undefined;
                                    } | {
                                        type: string;
                                        items: {
                                            type: string[];
                                        };
                                    })[];
                                };
                            };
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                extends: {
                    oneOf: ({
                        type: string;
                        properties?: undefined;
                        required?: undefined;
                        additionalProperties?: undefined;
                    } | {
                        type: string;
                        properties: {
                            service: {
                                type: string;
                                description: string;
                            };
                            file: {
                                type: string;
                                description: string;
                            };
                        };
                        required: string[];
                        additionalProperties: boolean;
                    })[];
                    description: string;
                };
                links: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                external_links: {
                    type: string;
                    items: {
                        type: string;
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                pre_start: {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    description: string;
                };
                post_start: {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    description: string;
                };
                pre_stop: {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    description: string;
                };
            };
            unevaluatedProperties: boolean;
        };
        job: {
            description: string;
            allOf: {
                $ref: string;
            }[];
            required: string[];
            properties: {
                profiles: {
                    $ref: string;
                    description: string;
                };
                extends: {
                    oneOf: ({
                        type: string;
                        properties?: undefined;
                        required?: undefined;
                        additionalProperties?: undefined;
                    } | {
                        type: string;
                        properties: {
                            service: {
                                type: string;
                                description: string;
                            };
                            file: {
                                type: string;
                                description: string;
                            };
                        };
                        required: string[];
                        additionalProperties: boolean;
                    })[];
                    description: string;
                };
                triggers: {
                    type: string;
                    description: string;
                    properties: {
                        manual: {
                            type: string[];
                            description: string;
                        };
                        schedule: {
                            type: string;
                            description: string;
                            items: {
                                oneOf: ({
                                    type: string;
                                    description: string;
                                    $ref?: undefined;
                                } | {
                                    $ref: string;
                                    type?: undefined;
                                    description?: undefined;
                                })[];
                            };
                        };
                    };
                    anyOf: {
                        required: string[];
                    }[];
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
            };
            unevaluatedProperties: boolean;
        };
        schedule: {
            type: string;
            description: string;
            required: string[];
            properties: {
                cron: {
                    type: string;
                    description: string;
                };
                timezone: {
                    type: string;
                    description: string;
                };
                concurrency: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                missed_fires: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        healthcheck: {
            type: string;
            description: string;
            properties: {
                disable: {
                    type: string[];
                    description: string;
                };
                interval: {
                    type: string;
                    description: string;
                };
                retries: {
                    type: string[];
                    description: string;
                };
                test: {
                    oneOf: ({
                        type: string;
                        items?: undefined;
                    } | {
                        type: string;
                        items: {
                            type: string;
                        };
                    })[];
                    description: string;
                };
                timeout: {
                    type: string;
                    description: string;
                };
                start_period: {
                    type: string;
                    description: string;
                };
                start_interval: {
                    type: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        development: {
            type: string[];
            description: string;
            properties: {
                watch: {
                    type: string;
                    description: string;
                    items: {
                        type: string;
                        required: string[];
                        properties: {
                            ignore: {
                                $ref: string;
                                description: string;
                            };
                            include: {
                                $ref: string;
                                description: string;
                            };
                            path: {
                                type: string;
                                description: string;
                            };
                            action: {
                                type: string;
                                enum: string[];
                                description: string;
                            };
                            target: {
                                type: string;
                                description: string;
                            };
                            exec: {
                                $ref: string;
                                description: string;
                            };
                            initial_sync: {
                                type: string;
                                description: string;
                            };
                        };
                        additionalProperties: boolean;
                        patternProperties: {
                            "^x-": {};
                        };
                    };
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        deployment: {
            type: string[];
            description: string;
            properties: {
                mode: {
                    type: string;
                    description: string;
                };
                endpoint_mode: {
                    type: string;
                    description: string;
                };
                replicas: {
                    type: string[];
                    description: string;
                };
                labels: {
                    $ref: string;
                    description: string;
                };
                rollback_config: {
                    type: string;
                    description: string;
                    properties: {
                        parallelism: {
                            type: string[];
                            description: string;
                        };
                        delay: {
                            type: string;
                            description: string;
                        };
                        failure_action: {
                            type: string;
                            description: string;
                        };
                        monitor: {
                            type: string;
                            description: string;
                        };
                        max_failure_ratio: {
                            type: string[];
                            description: string;
                        };
                        order: {
                            type: string;
                            enum: string[];
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                update_config: {
                    type: string;
                    description: string;
                    properties: {
                        parallelism: {
                            type: string[];
                            description: string;
                        };
                        delay: {
                            type: string;
                            description: string;
                        };
                        failure_action: {
                            type: string;
                            description: string;
                        };
                        monitor: {
                            type: string;
                            description: string;
                        };
                        max_failure_ratio: {
                            type: string[];
                            description: string;
                        };
                        order: {
                            type: string;
                            enum: string[];
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                resources: {
                    type: string;
                    description: string;
                    properties: {
                        limits: {
                            type: string;
                            description: string;
                            properties: {
                                cpus: {
                                    type: string[];
                                    description: string;
                                };
                                memory: {
                                    type: string;
                                    description: string;
                                };
                                pids: {
                                    type: string[];
                                    description: string;
                                };
                            };
                            additionalProperties: boolean;
                            patternProperties: {
                                "^x-": {};
                            };
                        };
                        reservations: {
                            type: string;
                            description: string;
                            properties: {
                                cpus: {
                                    type: string[];
                                    description: string;
                                };
                                memory: {
                                    type: string;
                                    description: string;
                                };
                                generic_resources: {
                                    $ref: string;
                                    description: string;
                                };
                                devices: {
                                    $ref: string;
                                    description: string;
                                };
                            };
                            additionalProperties: boolean;
                            patternProperties: {
                                "^x-": {};
                            };
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                restart_policy: {
                    type: string;
                    description: string;
                    properties: {
                        condition: {
                            type: string;
                            description: string;
                        };
                        delay: {
                            type: string;
                            description: string;
                        };
                        max_attempts: {
                            type: string[];
                            description: string;
                        };
                        window: {
                            type: string;
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                placement: {
                    type: string;
                    description: string;
                    properties: {
                        constraints: {
                            type: string;
                            items: {
                                type: string;
                            };
                            description: string;
                        };
                        preferences: {
                            type: string;
                            description: string;
                            items: {
                                type: string;
                                properties: {
                                    spread: {
                                        type: string;
                                        description: string;
                                    };
                                };
                                additionalProperties: boolean;
                                patternProperties: {
                                    "^x-": {};
                                };
                            };
                        };
                        max_replicas_per_node: {
                            type: string[];
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        generic_resources: {
            type: string;
            description: string;
            items: {
                type: string;
                properties: {
                    discrete_resource_spec: {
                        type: string;
                        description: string;
                        properties: {
                            kind: {
                                type: string;
                                description: string;
                            };
                            value: {
                                type: string[];
                                description: string;
                            };
                        };
                        additionalProperties: boolean;
                        patternProperties: {
                            "^x-": {};
                        };
                    };
                };
                additionalProperties: boolean;
                patternProperties: {
                    "^x-": {};
                };
            };
        };
        devices: {
            type: string;
            description: string;
            items: {
                type: string;
                properties: {
                    capabilities: {
                        $ref: string;
                        description: string;
                    };
                    count: {
                        type: string[];
                        description: string;
                    };
                    device_ids: {
                        $ref: string;
                        description: string;
                    };
                    driver: {
                        type: string;
                        description: string;
                    };
                    options: {
                        $ref: string;
                        description: string;
                    };
                };
                additionalProperties: boolean;
                patternProperties: {
                    "^x-": {};
                };
                required: string[];
            };
        };
        gpus: {
            oneOf: ({
                type: string;
                enum: string[];
                description: string;
                items?: undefined;
                additionalProperties?: undefined;
                patternProperties?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        capabilities: {
                            $ref: string;
                            description: string;
                        };
                        count: {
                            type: string[];
                            description: string;
                        };
                        device_ids: {
                            $ref: string;
                            description: string;
                        };
                        driver: {
                            type: string;
                            description: string;
                        };
                        options: {
                            $ref: string;
                            description: string;
                        };
                    };
                };
                additionalProperties: boolean;
                patternProperties: {
                    "^x-": {};
                };
                enum?: undefined;
            })[];
        };
        include: {
            description: string;
            oneOf: ({
                type: string;
                properties?: undefined;
                additionalProperties?: undefined;
            } | {
                type: string;
                properties: {
                    path: {
                        $ref: string;
                        description: string;
                    };
                    env_file: {
                        $ref: string;
                        description: string;
                    };
                    project_directory: {
                        type: string;
                        description: string;
                    };
                };
                additionalProperties: boolean;
            })[];
        };
        network: {
            type: string[];
            description: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                driver: {
                    type: string;
                    description: string;
                };
                driver_opts: {
                    type: string;
                    description: string;
                    patternProperties: {
                        "^.+$": {
                            type: string[];
                        };
                    };
                };
                ipam: {
                    type: string;
                    description: string;
                    properties: {
                        driver: {
                            type: string;
                            description: string;
                        };
                        config: {
                            type: string;
                            description: string;
                            items: {
                                type: string;
                                properties: {
                                    subnet: {
                                        type: string;
                                        description: string;
                                    };
                                    ip_range: {
                                        type: string;
                                        description: string;
                                    };
                                    gateway: {
                                        type: string;
                                        description: string;
                                    };
                                    aux_addresses: {
                                        type: string;
                                        description: string;
                                        additionalProperties: boolean;
                                        patternProperties: {
                                            "^.+$": {
                                                type: string;
                                            };
                                        };
                                    };
                                };
                                additionalProperties: boolean;
                                patternProperties: {
                                    "^x-": {};
                                };
                            };
                        };
                        options: {
                            type: string;
                            description: string;
                            additionalProperties: boolean;
                            patternProperties: {
                                "^.+$": {
                                    type: string;
                                };
                            };
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                external: {
                    type: string[];
                    description: string;
                    properties: {
                        name: {
                            deprecated: boolean;
                            type: string;
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                internal: {
                    type: string[];
                    description: string;
                };
                enable_ipv4: {
                    type: string[];
                    description: string;
                };
                enable_ipv6: {
                    type: string[];
                    description: string;
                };
                attachable: {
                    type: string[];
                    description: string;
                };
                labels: {
                    $ref: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        volume: {
            type: string[];
            description: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                driver: {
                    type: string;
                    description: string;
                };
                driver_opts: {
                    type: string;
                    description: string;
                    patternProperties: {
                        "^.+$": {
                            type: string[];
                        };
                    };
                };
                external: {
                    type: string[];
                    description: string;
                    properties: {
                        name: {
                            deprecated: boolean;
                            type: string;
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                };
                labels: {
                    $ref: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        secret: {
            type: string;
            description: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                environment: {
                    type: string;
                    description: string;
                };
                file: {
                    type: string;
                    description: string;
                };
                external: {
                    type: string[];
                    description: string;
                    properties: {
                        name: {
                            type: string;
                            description: string;
                        };
                    };
                };
                labels: {
                    $ref: string;
                    description: string;
                };
                driver: {
                    type: string;
                    description: string;
                };
                driver_opts: {
                    type: string;
                    description: string;
                    patternProperties: {
                        "^.+$": {
                            type: string[];
                        };
                    };
                };
                template_driver: {
                    type: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        config: {
            type: string;
            description: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                content: {
                    type: string;
                    description: string;
                };
                environment: {
                    type: string;
                    description: string;
                };
                file: {
                    type: string;
                    description: string;
                };
                external: {
                    type: string[];
                    description: string;
                    properties: {
                        name: {
                            deprecated: boolean;
                            type: string;
                            description: string;
                        };
                    };
                };
                labels: {
                    $ref: string;
                    description: string;
                };
                template_driver: {
                    type: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        model: {
            type: string;
            description: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                model: {
                    type: string;
                    description: string;
                };
                context_size: {
                    type: string;
                };
                runtime_flags: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
            };
            required: string[];
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
        };
        command: {
            oneOf: ({
                type: string;
                description: string;
                items?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    type: string;
                    description: string;
                };
            })[];
            description: string;
        };
        service_hook: {
            type: string;
            description: string;
            properties: {
                command: {
                    $ref: string;
                    description: string;
                };
                user: {
                    type: string;
                    description: string;
                };
                privileged: {
                    type: string[];
                    description: string;
                };
                working_dir: {
                    type: string;
                    description: string;
                };
                environment: {
                    $ref: string;
                    description: string;
                };
            };
            additionalProperties: boolean;
            patternProperties: {
                "^x-": {};
            };
            required: string[];
        };
        pre_start_hook: {
            type: string;
            description: string;
            allOf: {
                $ref: string;
            }[];
            unevaluatedProperties: boolean;
            properties: {
                per_replica: {
                    type: string[];
                    description: string;
                };
            };
        };
        env_file: {
            oneOf: ({
                type: string;
                description: string;
                items?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    oneOf: ({
                        type: string;
                        description: string;
                        additionalProperties?: undefined;
                        properties?: undefined;
                        required?: undefined;
                    } | {
                        type: string;
                        description: string;
                        additionalProperties: boolean;
                        properties: {
                            path: {
                                type: string;
                                description: string;
                            };
                            format: {
                                type: string;
                                description: string;
                            };
                            required: {
                                type: string[];
                                default: boolean;
                                description: string;
                            };
                        };
                        required: string[];
                    })[];
                };
            })[];
        };
        label_file: {
            oneOf: ({
                type: string;
                description: string;
                items?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    type: string;
                    description: string;
                };
            })[];
        };
        string_or_list: {
            oneOf: ({
                type: string;
                description: string;
                $ref?: undefined;
            } | {
                $ref: string;
                description: string;
                type?: undefined;
            })[];
            description: string;
        };
        list_of_strings: {
            type: string;
            description: string;
            items: {
                type: string;
                description: string;
            };
            uniqueItems: boolean;
        };
        list_or_dict: {
            oneOf: ({
                type: string;
                description: string;
                patternProperties: {
                    ".+": {
                        type: string[];
                        description: string;
                    };
                };
                additionalProperties: boolean;
                items?: undefined;
                uniqueItems?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    type: string;
                    description: string;
                };
                uniqueItems: boolean;
                patternProperties?: undefined;
                additionalProperties?: undefined;
            })[];
            description: string;
        };
        extra_hosts: {
            oneOf: ({
                type: string;
                description: string;
                patternProperties: {
                    ".+": {
                        oneOf: ({
                            type: string;
                            description: string;
                            items?: undefined;
                            uniqueItems?: undefined;
                        } | {
                            type: string;
                            description: string;
                            items: {
                                type: string;
                                description: string;
                            };
                            uniqueItems: boolean;
                        })[];
                    };
                };
                additionalProperties: boolean;
                items?: undefined;
                uniqueItems?: undefined;
            } | {
                type: string;
                description: string;
                items: {
                    type: string;
                    description: string;
                };
                uniqueItems: boolean;
                patternProperties?: undefined;
                additionalProperties?: undefined;
            })[];
            description: string;
        };
        blkio_limit: {
            type: string;
            description: string;
            properties: {
                path: {
                    type: string;
                    description: string;
                };
                rate: {
                    type: string[];
                    description: string;
                };
            };
            additionalProperties: boolean;
        };
        blkio_weight: {
            type: string;
            description: string;
            properties: {
                path: {
                    type: string;
                    description: string;
                };
                weight: {
                    type: string[];
                    description: string;
                };
            };
            additionalProperties: boolean;
        };
        service_config_or_secret: {
            type: string;
            description: string;
            items: {
                oneOf: ({
                    type: string;
                    description: string;
                    properties?: undefined;
                    additionalProperties?: undefined;
                    patternProperties?: undefined;
                } | {
                    type: string;
                    description: string;
                    properties: {
                        source: {
                            type: string;
                            description: string;
                        };
                        target: {
                            type: string;
                            description: string;
                        };
                        uid: {
                            type: string;
                            description: string;
                        };
                        gid: {
                            type: string;
                            description: string;
                        };
                        mode: {
                            type: string[];
                            description: string;
                        };
                    };
                    additionalProperties: boolean;
                    patternProperties: {
                        "^x-": {};
                    };
                })[];
            };
        };
        ulimits: {
            type: string;
            description: string;
            patternProperties: {
                "^[a-z]+$": {
                    oneOf: ({
                        type: string[];
                        description: string;
                        properties?: undefined;
                        required?: undefined;
                        additionalProperties?: undefined;
                        patternProperties?: undefined;
                    } | {
                        type: string;
                        description: string;
                        properties: {
                            hard: {
                                type: string[];
                                description: string;
                            };
                            soft: {
                                type: string[];
                                description: string;
                            };
                        };
                        required: string[];
                        additionalProperties: boolean;
                        patternProperties: {
                            "^x-": {};
                        };
                    })[];
                };
            };
        };
        workload_spec: {
            type: string;
            description: string;
            properties: {
                build: {
                    description: string;
                    oneOf: ({
                        type: string;
                        description: string;
                        properties?: undefined;
                        additionalProperties?: undefined;
                        patternProperties?: undefined;
                    } | {
                        type: string;
                        properties: {
                            context: {
                                type: string;
                                description: string;
                            };
                            dockerfile: {
                                type: string;
                                description: string;
                            };
                            dockerfile_inline: {
                                type: string;
                                description: string;
                            };
                            entitlements: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                            args: {
                                $ref: string;
                                description: string;
                            };
                            ssh: {
                                $ref: string;
                                description: string;
                            };
                            labels: {
                                $ref: string;
                                description: string;
                            };
                            cache_from: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                            cache_to: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                            no_cache: {
                                type: string[];
                                description: string;
                            };
                            no_cache_filter: {
                                $ref: string;
                                description: string;
                            };
                            additional_contexts: {
                                $ref: string;
                                description: string;
                            };
                            network: {
                                type: string;
                                description: string;
                            };
                            provenance: {
                                type: string[];
                                description: string;
                            };
                            sbom: {
                                type: string[];
                                description: string;
                            };
                            pull: {
                                type: string[];
                                description: string;
                            };
                            target: {
                                type: string;
                                description: string;
                            };
                            shm_size: {
                                type: string[];
                                description: string;
                            };
                            extra_hosts: {
                                $ref: string;
                                description: string;
                            };
                            isolation: {
                                type: string;
                                description: string;
                            };
                            privileged: {
                                type: string[];
                                description: string;
                            };
                            secrets: {
                                $ref: string;
                                description: string;
                            };
                            tags: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                            ulimits: {
                                $ref: string;
                                description: string;
                            };
                            platforms: {
                                type: string;
                                items: {
                                    type: string;
                                };
                                description: string;
                            };
                        };
                        additionalProperties: boolean;
                        patternProperties: {
                            "^x-": {};
                        };
                        description?: undefined;
                    })[];
                };
                depends_on: {
                    oneOf: ({
                        $ref: string;
                        type?: undefined;
                        additionalProperties?: undefined;
                        patternProperties?: undefined;
                    } | {
                        type: string;
                        additionalProperties: boolean;
                        patternProperties: {
                            "^[a-zA-Z0-9._-]+$": {
                                type: string;
                                additionalProperties: boolean;
                                patternProperties: {
                                    "^x-": {};
                                };
                                properties: {
                                    restart: {
                                        type: string[];
                                        description: string;
                                    };
                                    required: {
                                        type: string;
                                        default: boolean;
                                        description: string;
                                    };
                                    condition: {
                                        type: string;
                                        enum: string[];
                                        description: string;
                                    };
                                };
                                required: string[];
                            };
                        };
                        $ref?: undefined;
                    })[];
                    description: string;
                };
                healthcheck: {
                    $ref: string;
                    description: string;
                };
                ports: {
                    type: string;
                    description: string;
                    items: {
                        oneOf: ({
                            type: string;
                            properties?: undefined;
                            additionalProperties?: undefined;
                            patternProperties?: undefined;
                        } | {
                            type: string;
                            properties: {
                                name: {
                                    type: string;
                                    description: string;
                                };
                                mode: {
                                    type: string;
                                    description: string;
                                };
                                host_ip: {
                                    type: string;
                                    description: string;
                                };
                                target: {
                                    type: string[];
                                    description: string;
                                };
                                published: {
                                    type: string[];
                                    description: string;
                                };
                                protocol: {
                                    type: string;
                                    description: string;
                                };
                                app_protocol: {
                                    type: string;
                                    description: string;
                                };
                            };
                            additionalProperties: boolean;
                            patternProperties: {
                                "^x-": {};
                            };
                        })[];
                    };
                    uniqueItems: boolean;
                };
                expose: {
                    type: string;
                    items: {
                        type: string[];
                    };
                    uniqueItems: boolean;
                    description: string;
                };
                stdin_open: {
                    type: string[];
                    description: string;
                };
                tty: {
                    type: string[];
                    description: string;
                };
            };
            patternProperties: {
                "^x-": {};
            };
        };
    };
};
//# sourceMappingURL=compose-spec-schema.d.ts.map