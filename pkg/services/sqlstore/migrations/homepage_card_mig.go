package migrations

import (
	. "github.com/grafana/grafana/pkg/services/sqlstore/migrator"
)

func addHomePageCardMigrations(mg *Migrator) {
	homePageCardV1 := Table{
		Name: "home_page_card",
		Columns: []*Column{
			{Name: "id", Type: DB_BigInt, Nullable: false, IsPrimaryKey: true, IsAutoIncrement: true},
			{Name: "org_id", Type: DB_BigInt, Nullable: false},
			{Name: "device_mac", Type: DB_NVarchar, Length: 64, Nullable: false},
			{Name: "card_name", Type: DB_NVarchar, Length: 190, Nullable: false},
			{Name: "dashboard_uid", Type: DB_NVarchar, Length: 40, Nullable: true},
			{Name: "created", Type: DB_DateTime, Nullable: false},
			{Name: "updated", Type: DB_DateTime, Nullable: false},
		},
		Indices: []*Index{
			{Cols: []string{"org_id", "device_mac"}, Type: UniqueIndex},
			{Cols: []string{"org_id"}, Type: IndexType},
		},
	}

	mg.AddMigration("create home_page_card table v1", NewAddTableMigration(homePageCardV1))
	mg.AddMigration("add unique index home_page_card.org_id_device_mac", NewAddIndexMigration(homePageCardV1, homePageCardV1.Indices[0]))
	mg.AddMigration("add index home_page_card.org_id", NewAddIndexMigration(homePageCardV1, homePageCardV1.Indices[1]))
	mg.AddMigration("add column device_type in home_page_card", NewAddColumnMigration(homePageCardV1, &Column{
		Name: "device_type", Type: DB_NVarchar, Length: 64, Nullable: true,
	}))
}
