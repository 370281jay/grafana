package migrations

import (
    . "github.com/grafana/grafana/pkg/services/sqlstore/migrator"
)

func addDeviceMigrations(mg *Migrator) {
    deviceTable := Table{
        Name: "device",
        Columns: []*Column{
            {Name: "id", Type: DB_BigInt, Nullable: false, IsPrimaryKey: true, IsAutoIncrement: true},
            {Name: "org_id", Type: DB_BigInt, Nullable: false},
            {Name: "name", Type: DB_NVarchar, Length: 190, Nullable: false},
            {Name: "device_mac", Type: DB_NVarchar, Length: 64, Nullable: false},
            {Name: "device_type", Type: DB_NVarchar, Length: 64, Nullable: true},
            {Name: "description", Type: DB_Text, Nullable: true},
            {Name: "created", Type: DB_DateTime, Nullable: false},
            {Name: "updated", Type: DB_DateTime, Nullable: false},
        },
        Indices: []*Index{
            {Cols: []string{"org_id", "device_mac"}, Type: UniqueIndex},
            {Cols: []string{"org_id"}, Type: IndexType},
        },
    }

    mg.AddMigration("create device table v1", NewAddTableMigration(deviceTable))
    mg.AddMigration("add unique index device.org_id_device_mac", NewAddIndexMigration(deviceTable, deviceTable.Indices[0]))
    mg.AddMigration("add index device.org_id", NewAddIndexMigration(deviceTable, deviceTable.Indices[1]))
}
