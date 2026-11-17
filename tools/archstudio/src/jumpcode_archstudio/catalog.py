# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Known data stores, brokers and external services, by library name, URL scheme or host."""

import re

from .common import slug

# key -> (node id, level, display name, tech, link protocol)
TARGETS = {
    "postgresql": ("d:postgresql", "data", "PostgreSQL", "PostgreSQL", "SQL"),
    "mysql": ("d:mysql", "data", "MySQL", "MySQL", "SQL"),
    "sqlite": ("d:sqlite", "data", "SQLite", "SQLite", "SQL"),
    "mongodb": ("d:mongodb", "data", "MongoDB", "MongoDB", "MongoDB"),
    "redis": ("d:redis", "data", "Redis", "Redis", "Redis"),
    "elasticsearch": ("d:elasticsearch", "data", "Elasticsearch", "Elasticsearch", "HTTP"),
    "dynamodb": ("d:dynamodb", "data", "DynamoDB", "AWS DynamoDB", "HTTP"),
    "firestore": ("d:firestore", "data", "Firestore", "Firebase", "HTTP"),
    "s3": ("d:s3", "data", "Amazon S3", "AWS S3", "HTTP"),
    "clickhouse": ("d:clickhouse", "data", "ClickHouse", "ClickHouse", "SQL"),
    "cassandra": ("d:cassandra", "data", "Cassandra", "Cassandra", "CQL"),
    "influxdb": ("d:influxdb", "data", "InfluxDB", "InfluxDB", "HTTP"),
    "rabbitmq": ("q:rabbitmq", "queue", "RabbitMQ", "AMQP", "AMQP"),
    "kafka": ("q:kafka", "queue", "Kafka", "Kafka", "Kafka"),
    "nats": ("q:nats", "queue", "NATS", "NATS", "NATS"),
    "mqtt": ("q:mqtt", "queue", "Broker MQTT", "MQTT", "MQTT"),
    "sqs": ("q:sqs", "queue", "Amazon SQS", "AWS SQS", "SQS"),
    "redis-pubsub": ("q:redis", "queue", "Redis Pub/Sub", "Redis", "Redis"),
    "stripe": ("x:stripe", "external", "Stripe", None, "HTTP"),
    "mercadopago": ("x:mercadopago", "external", "Mercado Pago", None, "HTTP"),
    "pagseguro": ("x:pagseguro", "external", "PagSeguro", None, "HTTP"),
    "pagarme": ("x:pagarme", "external", "Pagar.me", None, "HTTP"),
    "pix": ("x:pix", "external", "Gateway Pix", None, "HTTP"),
    "twilio": ("x:twilio", "external", "Twilio", None, "HTTP"),
    "sendgrid": ("x:sendgrid", "external", "SendGrid", None, "HTTP"),
    "whatsapp": ("x:whatsapp", "external", "WhatsApp Business", None, "HTTP"),
    "firebase": ("x:firebase", "external", "Firebase", None, "HTTP"),
    "openai": ("x:openai", "external", "OpenAI", None, "HTTP"),
    "anthropic": ("x:anthropic", "external", "Anthropic", None, "HTTP"),
    "gemini": ("x:gemini", "external", "Google Gemini", None, "HTTP"),
    "google-maps": ("x:google-maps", "external", "Google Maps", None, "HTTP"),
    "mapbox": ("x:mapbox", "external", "Mapbox", None, "HTTP"),
    "openstreetmap": ("x:openstreetmap", "external", "OpenStreetMap", None, "HTTP"),
    "sentry": ("x:sentry", "external", "Sentry", None, "HTTP"),
    "onesignal": ("x:onesignal", "external", "OneSignal", None, "HTTP"),
    "viacep": ("x:viacep", "external", "ViaCEP", None, "HTTP"),
    "telegram": ("x:telegram", "external", "Telegram", None, "HTTP"),
    "slack": ("x:slack", "external", "Slack", None, "HTTP"),
    "github": ("x:github", "external", "GitHub API", None, "HTTP"),
    "aws": ("x:aws", "external", "AWS", None, "HTTP"),
    "google-storage": ("d:google-storage", "data", "Google Cloud Storage", "GCS", "HTTP"),
    "google-apis": ("x:google-apis", "external", "Google APIs", None, "HTTP"),
}
BROKERS = ("rabbitmq", "kafka", "nats", "mqtt", "redis-pubsub", "sqs")
LOCAL_STORES = {"sqlite"}

# Library names as imported in code (lower case). A name matches itself and anything below it
# ("github.com/jackc/pgx" matches ".../pgx/v5", "paho" matches "paho.mqtt.client").
LIBRARIES = (
    ("postgresql", ("github.com/jackc/pgx", "github.com/lib/pq", "gorm.io/driver/postgres", "pg", "postgres", "pg-promise",
                    "psycopg", "psycopg2", "asyncpg", "npgsql", "org.postgresql", "tokio-postgres", "postgresql", "postgres.js")),
    ("mysql", ("github.com/go-sql-driver/mysql", "gorm.io/driver/mysql", "mysql", "mysql2", "pymysql", "mysqldb",
               "mysql.connector", "mysql.data", "com.mysql", "aiomysql")),
    ("sqlite", ("github.com/mattn/go-sqlite3", "modernc.org/sqlite", "gorm.io/driver/sqlite", "sqlite3", "better-sqlite3",
                "sqflite", "drift", "moor", "sqlite", "rusqlite", "expo-sqlite", "react-native-sqlite-storage",
                "@op-engineering/op-sqlite", "androidx.room", "microsoft.data.sqlite", "sqlite3.h", "isar", "realm",
                "hive", "hive_flutter", "objectbox")),
    ("mongodb", ("go.mongodb.org/mongo-driver", "mongodb", "mongoose", "pymongo", "motor", "mongodb.driver", "org.mongodb",
                 "mongo_dart", "mongoengine")),
    ("redis", ("github.com/redis/go-redis", "github.com/go-redis/redis", "github.com/gomodule/redigo", "redis", "ioredis",
               "aioredis", "stackexchange.redis", "redis.clients.jedis", "io.lettuce", "org.springframework.data.redis")),
    ("elasticsearch", ("github.com/elastic/go-elasticsearch", "github.com/olivere/elastic", "@elastic/elasticsearch",
                       "elasticsearch", "elastic.clients.elasticsearch", "org.elasticsearch", "@opensearch-project/opensearch",
                       "opensearchpy")),
    ("dynamodb", ("@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "github.com/aws/aws-sdk-go-v2/service/dynamodb",
                  "github.com/aws/aws-sdk-go/service/dynamodb")),
    ("firestore", ("cloud_firestore", "firebase/firestore", "@google-cloud/firestore", "cloud.google.com/go/firestore",
                   "google.cloud.firestore", "@react-native-firebase/firestore", "firebase-admin/firestore")),
    ("s3", ("@aws-sdk/client-s3", "github.com/aws/aws-sdk-go-v2/service/s3", "github.com/aws/aws-sdk-go/service/s3",
            "minio", "github.com/minio/minio-go")),
    ("clickhouse", ("github.com/clickhouse/clickhouse-go", "@clickhouse/client", "clickhouse_driver", "clickhouse_connect")),
    ("cassandra", ("github.com/gocql/gocql", "cassandra-driver", "cassandra")),
    ("influxdb", ("influxdb", "@influxdata/influxdb-client", "github.com/influxdata/influxdb-client-go", "influxdb_client")),
    ("rabbitmq", ("github.com/rabbitmq/amqp091-go", "github.com/streadway/amqp", "amqplib", "amqp-connection-manager",
                  "pika", "aio_pika", "rabbitmq.client", "org.springframework.amqp", "com.rabbitmq", "lapin", "bunny",
                  "kombu", "dart_amqp")),
    ("kafka", ("github.com/segmentio/kafka-go", "github.com/confluentinc/confluent-kafka-go", "github.com/ibm/sarama",
               "github.com/shopify/sarama", "kafkajs", "kafka", "aiokafka", "confluent_kafka", "confluent.kafka",
               "org.apache.kafka", "org.springframework.kafka", "rdkafka")),
    ("nats", ("github.com/nats-io/nats.go", "nats", "nats.ws", "async-nats")),
    ("mqtt", ("github.com/eclipse/paho.mqtt.golang", "github.com/eclipse/paho.golang", "mqtt", "paho", "async-mqtt",
              "mqtt_client", "mqtt_client.h", "pubsubclient.h", "mqttclient.h", "asyncmqttclient.h", "rumqttc",
              "mqttnet", "org.eclipse.paho", "com.hivemq", "precise-mqtt", "aiomqtt", "asyncio-mqtt", "gmqtt")),
    ("sqs", ("@aws-sdk/client-sqs", "github.com/aws/aws-sdk-go-v2/service/sqs", "github.com/aws/aws-sdk-go/service/sqs")),
    ("stripe", ("stripe", "github.com/stripe/stripe-go", "com.stripe", "stripe.net", "@stripe/stripe-js",
                "@stripe/stripe-react-native", "flutter_stripe")),
    ("mercadopago", ("mercadopago", "com.mercadopago", "github.com/mercadopago", "mercado_pago", "mercadopago-sdk")),
    ("twilio", ("twilio", "github.com/twilio/twilio-go", "com.twilio")),
    ("sendgrid", ("@sendgrid/mail", "sendgrid", "github.com/sendgrid/sendgrid-go", "com.sendgrid")),
    ("firebase", ("firebase_messaging", "firebase_core", "firebase_auth", "firebase_analytics", "firebase_crashlytics",
                  "@react-native-firebase/app", "@react-native-firebase/messaging", "firebase-admin", "firebase",
                  "firebase.google.com/go", "com.google.firebase", "firebase_admin")),
    ("openai", ("openai", "github.com/sashabaranov/go-openai", "github.com/openai/openai-go", "com.theokanning.openai")),
    ("anthropic", ("anthropic", "@anthropic-ai/sdk", "github.com/anthropics/anthropic-sdk-go")),
    ("google-maps", ("google_maps_flutter", "react-native-maps", "@googlemaps", "googlemaps", "@react-google-maps/api",
                     "googlemaps.github.io/maps", "com.google.android.gms.maps", "com.google.maps", "google_maps_webservice")),
    ("sentry", ("sentry_flutter", "@sentry", "sentry_sdk", "sentry-sdk", "github.com/getsentry/sentry-go", "io.sentry", "sentry")),
    ("onesignal", ("onesignal_flutter", "react-native-onesignal", "onesignal", "react-onesignal")),
    ("aws", ("aws-sdk", "boto3", "github.com/aws/aws-sdk-go", "github.com/aws/aws-sdk-go-v2", "@aws-sdk", "software.amazon.awssdk",
             "com.amazonaws")),
)
_SEPARATORS = ("/", ".", "::", ":")


def library_target(spec, exact=False):
    """Return the TARGETS key of an imported library, or None. C headers match exactly."""
    spec = (spec or "").lower().strip()
    if not spec:
        return None
    for key, names in LIBRARIES:
        for name in names:
            if spec == name or (not exact and any(spec.startswith(name + separator) for separator in _SEPARATORS)):
                return key
    return None


HOSTS = (
    (re.compile(r"(^|\.)(maps|routes|roads|places)\.googleapis\.com$"), "google-maps"),
    (re.compile(r"(^|\.)graph\.facebook\.com$|whatsapp"), "whatsapp"),
    (re.compile(r"(^|\.)stripe\.com$"), "stripe"),
    (re.compile(r"mercadopago|mercadolibre"), "mercadopago"),
    (re.compile(r"pagseguro"), "pagseguro"),
    (re.compile(r"pagar\.me$"), "pagarme"),
    (re.compile(r"(^|[.\-])pix([.\-]|$)"), "pix"),
    (re.compile(r"(^|\.)twilio\.com$"), "twilio"),
    (re.compile(r"(^|\.)sendgrid\.(com|net)$"), "sendgrid"),
    (re.compile(r"(^|\.)fcm\.googleapis\.com$|firebaseio\.com$|(^|\.)firebase\.googleapis\.com$"), "firebase"),
    (re.compile(r"(^|\.)openai\.com$"), "openai"),
    (re.compile(r"(^|\.)anthropic\.com$"), "anthropic"),
    (re.compile(r"(^|\.)generativelanguage\.googleapis\.com$"), "gemini"),
    (re.compile(r"(^|\.)s3[.\-][\w.\-]*amazonaws\.com$|(^|\.)s3\.amazonaws\.com$"), "s3"),
    (re.compile(r"(^|\.)dynamodb\.[\w.\-]*amazonaws\.com$"), "dynamodb"),
    (re.compile(r"(^|\.)sqs\.[\w.\-]*amazonaws\.com$"), "sqs"),
    (re.compile(r"amazonaws\.com$"), "aws"),
    (re.compile(r"(^|\.)sentry\.io$"), "sentry"),
    (re.compile(r"(^|\.)onesignal\.com$"), "onesignal"),
    (re.compile(r"(^|\.)mapbox\.com$"), "mapbox"),
    (re.compile(r"(^|\.)viacep\.com\.br$"), "viacep"),
    (re.compile(r"(^|\.)api\.telegram\.org$"), "telegram"),
    (re.compile(r"(^|\.)hooks\.slack\.com$|(^|\.)slack\.com$"), "slack"),
    (re.compile(r"(^|\.)api\.github\.com$"), "github"),
    (re.compile(r"openstreetmap\.org$|(^|\.)osrm"), "openstreetmap"),
    (re.compile(r"(^|\.)storage\.googleapis\.com$"), "google-storage"),
    (re.compile(r"\.googleapis\.com$"), "google-apis"),
)
IGNORED_HOST = re.compile(
    r"w3\.org$|(^|\.)example\.(com|org|net)$|^schemas?\.|json-schema\.org$|xmlns|purl\.org$|apache\.org$|opensource\.org$"
    r"|^(www\.)?github\.com$|githubusercontent\.com$|mozilla\.org$|microsoft\.com$|(^|\.)go\.dev$|golang\.org$|npmjs\.(com|org)$"
    r"|pypi\.org$|fonts\.(googleapis|gstatic)\.com$|unpkg\.com$|jsdelivr\.net$|cdnjs|gnu\.org$|creativecommons\.org$"
    r"|wikipedia\.org$|^(www\.)?google\.com(\.br)?$|youtube\.com$|youtu\.be$|schema\.org$|reactjs\.org$|react\.dev$"
    r"|flutter\.dev$|pub\.dev$|android\.com$|apple\.com$|ietf\.org$|^localhost$|^127\.|^0\.0\.0\.0$|^10\.|^192\.168\."
    r"|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.localhost$|\.test$|\.invalid$|\.example$|\.internal$|placeholder|picsum\.photos$"
    r"|gravatar\.com$|shields\.io$|readthedocs|stackoverflow\.com$|python\.org$|nodejs\.org$|docker\.(com|io)$|kubernetes\.io$"
    r"|jquery\.com$|bootstrapcdn\.com$|twitter\.com$|^x\.com$|linkedin\.com$|instagram\.com$|^(www\.)?facebook\.com$"
    r"|tiktok\.com$|swagger\.io$|openapis\.org$|spdx\.org$|semver\.org$|vercel\.app$|nextjs\.org$|tailwindcss\.com$"
    r"|svelte\.dev$|vuejs\.org$|angular\.io$|expo\.dev$|gstatic\.com$|googletagmanager\.com$|google-analytics\.com$"
    r"|visualstudio\.com$|vscode\.dev$|aka\.ms$|go\.microsoft\.com$|^[\d.]+$")
_TLD_PARTS = {"com", "net", "org", "io", "co", "br", "gov", "edu", "app", "dev", "cloud", "info", "biz", "me", "ai", "tech",
              "us", "uk", "de", "fr", "es", "pt", "ar", "mx", "cl", "eu", "online", "site", "xyz", "global", "digital"}
_HOST_PREFIXES = {"api", "apis", "www", "app", "sandbox", "staging", "homolog", "hml", "dev", "prod", "v1", "v2", "v3",
                  "secure", "gateway", "rest", "public", "service", "services", "ws", "cdn", "static"}


def host_target(host):
    """Return the TARGETS key of a well-known host, or None."""
    host = (host or "").lower().strip(".")
    for pattern, key in HOSTS:
        if pattern.search(host):
            return key
    return None


def ignored_host(host):
    return bool(IGNORED_HOST.search((host or "").lower()))


_PLACEHOLDERS = {"at", "domain", "evil", "example", "exemple", "exemplo", "host", "hostname", "mock", "new", "moved", "test",
                 "foo", "bar", "baz", "your", "yours", "my", "server", "service", "endpoint", "dummy", "fake", "sample",
                 "acme", "company", "empresa", "seu", "sua", "meu", "minha", "site", "url", "invalid", "none", "null"}
_API_PATH = re.compile(r"/(?:api|apis|v\d+(?:\.\d+)?|graphql|rest|rpc|webhooks?|oauth2?|token)(?:/|$|\?)", re.I)


def plausible_api(host, path, strict):
    """Unknown hosts become external nodes only when they look like a real API endpoint."""
    labels = [label for label in (host or "").lower().split(".") if label]
    if len(labels) < 2 or not re.fullmatch(r"[a-z]{2,24}", labels[-1]):
        return False
    if any(label in _PLACEHOLDERS or "example" in label or "exempl" in label or "placeholder" in label for label in labels):
        return False
    if not strict:
        return True
    return labels[0] in ("api", "apis", "gateway", "graph", "hooks", "webhook", "webhooks") or ".api." in host or bool(_API_PATH.search(path or ""))


def external_for_host(host):
    """A readable external node for an unknown host: 'api.frete-rapido.com.br' -> x:frete-rapido."""
    labels = [label for label in (host or "").lower().strip(".").split(".") if label]
    while len(labels) > 1 and labels[-1] in _TLD_PARTS:
        labels.pop()
    labels = [label for label in labels if label not in _HOST_PREFIXES] or labels
    if not labels:
        return None
    main = labels[-1]
    key = slug(main)
    if not key or len(key) < 2:
        return None
    name = " ".join(part.capitalize() for part in re.split(r"[-_]", main) if part)
    return "x:" + key, name[:40]


SCHEMES = {
    "postgres": "postgresql", "postgresql": "postgresql", "mysql": "mysql", "mongodb": "mongodb", "mongodb+srv": "mongodb",
    "redis": "redis", "rediss": "redis", "amqp": "rabbitmq", "amqps": "rabbitmq", "mqtt": "mqtt", "mqtts": "mqtt",
    "nats": "nats", "kafka": "kafka",
}
IMAGES = (
    (re.compile(r"(^|/)(postgres|postgis|timescale)"), "postgresql", "database"),
    (re.compile(r"(^|/)(mysql|mariadb|percona)"), "mysql", "database"),
    (re.compile(r"(^|/)mongo"), "mongodb", "database"),
    (re.compile(r"(^|/)(redis|valkey|keydb)"), "redis", "cache"),
    (re.compile(r"(^|/)(elasticsearch|opensearch)"), "elasticsearch", "database"),
    (re.compile(r"(^|/)(clickhouse)"), "clickhouse", "database"),
    (re.compile(r"(^|/)(cassandra|scylla)"), "cassandra", "database"),
    (re.compile(r"(^|/)influxdb"), "influxdb", "database"),
    (re.compile(r"(^|/)(rabbitmq)"), "rabbitmq", "queue"),
    (re.compile(r"(^|/)(cp-kafka|kafka|redpanda)"), "kafka", "queue"),
    (re.compile(r"(^|/)nats"), "nats", "queue"),
    (re.compile(r"(^|/)(eclipse-mosquitto|mosquitto|emqx|hivemq|vernemq)"), "mqtt", "queue"),
    (re.compile(r"(^|/)(minio)"), "s3", "database"),
    (re.compile(r"(^|/)(memcached)"), None, "cache"),
    (re.compile(r"(^|/)(nginx|traefik|haproxy|envoy|caddy|kong)"), None, "balancer"),
)
BROKER_NAMES = {"mosquitto": "Mosquitto", "eclipse-mosquitto": "Mosquitto", "emqx": "EMQX", "hivemq": "HiveMQ",
                "vernemq": "VerneMQ", "redpanda": "Redpanda"}


def image_target(image):
    """(TARGETS key or None, unit kind) for a container image name."""
    image = (image or "").lower()
    for pattern, key, kind in IMAGES:
        if pattern.search(image):
            return key, kind
    return None, "container"
